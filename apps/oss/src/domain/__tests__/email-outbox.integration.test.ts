import { executeIssuanceCommand } from "../../application/issuance"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../lib/email")>("../../lib/email")
  return { ...actual, deliver: vi.fn().mockResolvedValue({ id: "email_123" }) }
})

import { appRouter } from "../../trpc/router"
import { prisma } from "../../lib/db"
import { deliver, EmailSendError } from "../../lib/email"
import { deliverSmtp } from "../../lib/email-smtp-node"
import { withSmtpDisconnect, withUntrustedSmtpTls } from "../../test-utils/__tests__/smtp"
import { defaultNodePlatform } from "../../lib/runtime/node-platform"
import { resetRuntimePlatform, setRuntimePlatform } from "../../lib/runtime/platform"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { authenticateAgentSecret, createAgentKey } from "../agent-keys"
import { decideApproval } from "../approvals"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, sendInvoice, updateInvoiceDraft } from "../commands/invoices"
import { createQuoteDraft, sendQuote } from "../commands/quotes"
import { recordPayment } from "../commands/payments"
import {
  POLICY_DISABLED_MESSAGE,
  REMINDER_SEND_JOB,
  sendReminderNow,
  updateReminderPolicy,
} from "../commands/reminders"
import {
  EMAIL_DELIVERY_ATTEMPTS,
  EMAIL_DELIVERY_JOB,
  isDefiniteRejection,
  readDeliveryResult,
  settleAbandonedDeliveries,
} from "../delivery/outbox"
import { readActivity } from "../events"

import "../features/reminders"
import { registerJobHandler, runDueJobs } from "../jobs"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describe("isDefiniteRejection", () => {
  it("treats provider validation errors as refusals and outages or lost requests as uncertain", () => {
    expect(isDefiniteRejection(new EmailSendError("validation_error", "bad"))).toBe(true)
    expect(isDefiniteRejection(new EmailSendError("invalid_from_address", "bad"))).toBe(true)
    expect(isDefiniteRejection(new EmailSendError("smtp_unavailable", "Connection never opened"))).toBe(true)
    // The Resend SDK reports network failures as application_error.
    expect(isDefiniteRejection(new EmailSendError("application_error", "fetch failed"))).toBe(false)
    expect(isDefiniteRejection(new EmailSendError("internal_server_error", "oops"))).toBe(false)
    expect(isDefiniteRejection(new EmailSendError("rate_limit_exceeded", "slow down"))).toBe(false)
    expect(isDefiniteRejection(new Error("socket hang up"))).toBe(false)
    expect(isDefiniteRejection(new EmailSendError("smtp_partial_acceptance", "Some recipients refused"))).toBe(false)
  })
})

describeIfDatabase("email outbox", () => {
  const cleanups: Array<() => Promise<void>> = []
  const previousEnv = { RESEND_API_KEY: process.env.RESEND_API_KEY, FROM_EMAIL: process.env.FROM_EMAIL }

  beforeEach(() => {
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"
    vi.mocked(deliver).mockReset()
    vi.mocked(deliver).mockResolvedValue({ id: "email_123" })
  })

  afterEach(async () => {
    resetRuntimePlatform()
    while (cleanups.length) await cleanups.pop()?.()
    process.env.RESEND_API_KEY = previousEnv.RESEND_API_KEY
    process.env.FROM_EMAIL = previousEnv.FROM_EMAIL
    vi.unstubAllEnvs()
  })

  async function setup() {
    const org = await createTestOrganization({ roles: ["admin"] })
    cleanups.push(org.cleanup)
    const contact = await executeIssuanceCommand(
      createContact,
      { name: "Acme", email: "billing@acme.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const draft = await executeIssuanceCommand(
      createInvoiceDraft,
      {
        contactId: contact.result.id,
        dueDate: "2099-12-01",
        taxRate: 0,
        items: [{ description: "Design", quantity: 1, unitPrice: 100 }],
      },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error("draft setup failed")
    return { org, contactId: contact.result.id, invoiceId: draft.result.id }
  }

  const deliveryJob = (organizationId: string) =>
    prisma.job.findFirstOrThrow({ where: { organizationId, type: EMAIL_DELIVERY_JOB } })

  /** Makes the queued delivery due again, as if its backoff had passed. */
  const makeDue = (jobId: string) =>
    prisma.job.update({ where: { id: jobId }, data: { runAfter: new Date(Date.now() - 1000) } })

  function useSmtp() {
    vi.stubEnv("EMAIL_PROVIDER", "smtp")
    vi.stubEnv("SMTP_HOST", "relay.example.com")
  }

  it("blocks invoice and quote email sends before queuing SMTP on a Worker", async () => {
    const { org, invoiceId, contactId } = await setup()
    const quote = await executeIssuanceCommand(createQuoteDraft, { contactId, expiryDate: "2099-12-01", taxRate: 0, items: [{ description: "Design", quantity: 1, unitPrice: 100 }] }, { actor: org.actors.admin })
    if (quote.status !== "completed") throw new Error("quote setup failed")
    const environment: Record<string, string> = { EMAIL_PROVIDER: "smtp", SMTP_HOST: "relay.example", FROM_EMAIL: "worker-reader@example.com" }
    setRuntimePlatform({ ...defaultNodePlatform, id: "test-worker-smtp", getRuntimeKind: () => "worker", getEnv: (name) => environment[name] })
    const invoiceSend = await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    const quoteSend = await executeIssuanceCommand(sendQuote, { id: quote.result.id }, { actor: org.actors.admin })
    expect(invoiceSend).toMatchObject({ status: "failed", error: { code: "email_unavailable" } })
    expect(quoteSend).toMatchObject({ status: "failed", error: { code: "email_unavailable" } })
    expect(deliver).not.toHaveBeenCalled()
    expect(await prisma.job.count({ where: { organizationId: org.organizationId, type: EMAIL_DELIVERY_JOB } })).toBe(0)
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ status: "draft", lastEmailAttemptOutcome: null })
    expect(await prisma.quote.findUniqueOrThrow({ where: { id: quote.result.id } })).toMatchObject({ status: "draft", lastEmailAttemptOutcome: null })
  })

  it("never retries an ambiguous SMTP submission, even when configuration changes", async () => {
    const { org, invoiceId } = await setup()
    useSmtp()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("connection lost after DATA"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deliver).mock.calls[0]?.[1]).toMatchObject({ provider: "smtp" })
    const job = await deliveryJob(org.organizationId)
    expect(job).toMatchObject({ status: "failed", payload: { provider: "smtp", requests: 1 }, result: { outcome: "unconfirmed" } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "unconfirmed" })
    vi.stubEnv("EMAIL_PROVIDER", "resend")
    await makeDue(job.id)
    await runDueJobs({ organizationIds: [org.organizationId] })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("does not resubmit SMTP after a runner crashes before recording the acceptance", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("lost response"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    const job = await deliveryJob(org.organizationId)
    // Simulate a stopped SMTP runner with a recorded request but no acceptance or decision.
    await prisma.job.update({ where: { id: job.id }, data: { payload: { ...(job.payload as object), provider: "smtp" } } })
    await makeDue(job.id)
    vi.mocked(deliver).mockClear()
    await runDueJobs({ organizationIds: [org.organizationId] })
    expect(deliver).not.toHaveBeenCalled()
    expect((await deliveryJob(org.organizationId)).result).toMatchObject({ outcome: "unconfirmed" })
  })

  it("settles partial SMTP acceptance as unconfirmed without reopening or retrying", async () => {
    const { org, invoiceId } = await setup()
    useSmtp()
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("smtp_partial_acceptance", "Some recipients refused"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    const job = await deliveryJob(org.organizationId)
    expect(job).toMatchObject({ status: "failed", result: { outcome: "unconfirmed" } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "unconfirmed" })
    await makeDue(job.id)
    await runDueJobs({ organizationIds: [org.organizationId] })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("preserves Resend deduplication after the configured provider changes to SMTP", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("lost response"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    useSmtp()
    await makeDue((await deliveryJob(org.organizationId)).id)
    await runDueJobs({ organizationIds: [org.organizationId] })
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deliver).mock.calls[1]?.[1]).toMatchObject({ provider: "resend" })
    expect((await deliveryJob(org.organizationId)).result).toMatchObject({ outcome: "delivered" })
  })

  it("leaves the draft editable when SMTP explicitly refuses the only request", async () => {
    const { org, invoiceId } = await setup()
    useSmtp()
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("smtp_rejected", "SMTP server refused delivery (550)"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ status: "draft", lastEmailAttemptOutcome: "failed" })
    expect((await deliveryJob(org.organizationId)).result).toMatchObject({ outcome: "rejected" })
  })

  it("does not issue an invoice when SMTP proves the connection never opened", async () => {
    const { org, invoiceId } = await setup()
    useSmtp()
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("smtp_unavailable", "Connection never opened"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ status: "draft", lastEmailAttemptOutcome: "failed" })
    expect((await deliveryJob(org.organizationId)).result).toMatchObject({ outcome: "rejected" })
    expect(await prisma.domainEvent.count({ where: { organizationId: org.organizationId, aggregateId: invoiceId, type: "invoice.sent" } })).toBe(0)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it.each(["starttls", "implicit"] as const)("keeps an invoice editable after a real %s certificate failure", async (mode) => {
    const { org, invoiceId } = await setup()
    useSmtp()
    await withUntrustedSmtpTls(mode, async (environment, commands) => {
      vi.mocked(deliver).mockImplementationOnce((message) => deliverSmtp(message, environment))
      await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
      expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ status: "draft", lastEmailAttemptOutcome: "failed" })
      expect((await deliveryJob(org.organizationId)).result).toMatchObject({ outcome: "rejected" })
      expect(await prisma.domainEvent.count({ where: { organizationId: org.organizationId, aggregateId: invoiceId, type: "invoice.sent" } })).toBe(0)
      expect(commands.some((command) => /^(?:MAIL|RCPT|DATA)\b/.test(command))).toBe(false)
      const edit = await executeIssuanceCommand(updateInvoiceDraft, { id: invoiceId, notes: "Correct the relay certificate and try again" }, { actor: org.actors.admin })
      expect(edit.status).toBe("completed")
    })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("does not issue an invoice when a real relay closes before its greeting", async () => {
    const { org, invoiceId } = await setup()
    useSmtp()
    await withSmtpDisconnect("before-greeting", async (environment, commands, bodies) => {
      vi.mocked(deliver).mockImplementationOnce((message) => deliverSmtp(message, environment))
      await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
      expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ status: "draft", lastEmailAttemptOutcome: "failed" })
      expect((await deliveryJob(org.organizationId)).result).toMatchObject({ outcome: "rejected" })
      expect(await prisma.domainEvent.count({ where: { organizationId: org.organizationId, aggregateId: invoiceId, type: "invoice.sent" } })).toBe(0)
      expect(commands).toHaveLength(0)
      expect(bodies).toHaveLength(0)
      expect(await executeIssuanceCommand(updateInvoiceDraft, { id: invoiceId, notes: "Try a working relay" }, { actor: org.actors.admin })).toMatchObject({ status: "completed" })
    })
  })

  it("settles a recorded SMTP acceptance without another submission", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("lost response"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    const job = await deliveryJob(org.organizationId)
    await prisma.job.update({ where: { id: job.id }, data: { payload: { ...(job.payload as object), provider: "smtp", providerMessageId: "<accepted@relay.test>" } } })
    await makeDue(job.id)
    vi.mocked(deliver).mockClear()
    await runDueJobs({ organizationIds: [org.organizationId] })
    expect(deliver).not.toHaveBeenCalled()
    expect((await deliveryJob(org.organizationId)).result).toMatchObject({ outcome: "delivered" })
  })

  it("marks the invoice sent only after the provider accepts the email", async () => {
    const { org, invoiceId } = await setup()
    let statusDuringDelivery: string | undefined
    vi.mocked(deliver).mockImplementationOnce(async () => {
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
      statusDuringDelivery = `${invoice.status}/${invoice.lastEmailAttemptOutcome}`
      return { id: "email_1" }
    })

    const outcome = await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })

    expect(outcome).toMatchObject({ status: "completed", result: { emailPending: true } })
    expect(statusDuringDelivery).toBe("draft/sending")
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "sent" })
    expect(invoice.issueDate.getTime()).toBe(invoice.lastEmailAttemptAt?.getTime())
    const activity = await readActivity({ organizationId: org.organizationId, aggregateId: invoiceId })
    expect(activity.events.at(-1)).toMatchObject({
      type: "invoice.sent",
      actor: { kind: "user", id: org.actors.admin.userId },
    })
  })

  it("leaves an editable draft when the provider refuses the email", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "Domain is not verified"))

    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({
      status: "draft",
      lastEmailAttemptOutcome: "failed",
      lastEmailAttemptCode: "send_failed",
    })
    expect(invoice.lastEmailAttemptMessage).toBe("The email provider refused the email. Check the email configuration.")
    // A refusal is a permanent failure of the job, counted as failed.
    expect(await deliveryJob(org.organizationId)).toMatchObject({
      status: "failed",
      result: { outcome: "rejected", code: "email_provider_refused", message: "The email provider refused the email. Check the email configuration." },
    })
    const edited = await executeIssuanceCommand(
      updateInvoiceDraft,
      { id: invoiceId, notes: "Fixed the sender" },
      { actor: org.actors.admin }
    )
    expect(edited.status).toBe("completed")
  })

  it("sanitizes legacy document delivery messages on list and detail reads", async () => {
    const { org, invoiceId, contactId } = await setup()
    const failure = { lastEmailAttemptAt: new Date(), lastEmailAttemptOutcome: "failed", lastEmailAttemptCode: "send_failed", lastEmailAttemptMessage: "provider secret sk-test-sensitive" }
    await prisma.invoice.update({ where: { id: invoiceId }, data: failure })
    const quote = await prisma.quote.create({ data: { organizationId: org.organizationId, contactId,
      expiryDate: new Date("2099-12-01"), subtotalNet: "50", totalGross: "50", ...failure } })
    const credit = await prisma.creditNote.create({ data: { organizationId: org.organizationId, contactId, invoiceId,
      number: "CN-1", reason: "Return", currency: "DKK", countryCode: "US", locale: "en-US", timezone: "UTC",
      taxRegime: "us_sales_tax", subtotalNet: "10", totalGross: "10", ...failure } })
    const agreement = await prisma.agreement.create({ data: { organizationId: org.organizationId, contactId,
      title: "Work", termsMarkdown: "Terms", validUntil: new Date("2099-12-01"), subtotalNet: "50", totalGross: "50", ...failure } })
    const admin = appRouter.createCaller({ session: { user: { id: org.actors.admin.userId, name: "Admin", email: "admin@example.test" }, session: { activeOrganizationId: org.organizationId } } } as never)
    const documents = [await admin.invoices.get({ id: invoiceId }), await admin.quotes.get({ id: quote.id }),
      await admin.creditNotes.get({ id: credit.id }), await admin.agreements.get({ id: agreement.id })]
    for (const document of documents) expect(document.lastEmailAttemptMessage).toBe("The email provider refused the email. Check the email configuration.")
    expect(JSON.stringify([await admin.invoices.list(), await admin.quotes.list(), await admin.agreements.list()])).not.toContain("sk-test-sensitive")
  })

  it("sanitizes a legacy provider refusal when the abandoned-delivery sweep settles it", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("lost response"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    const job = await deliveryJob(org.organizationId)
    await prisma.job.update({ where: { id: job.id }, data: {
      status: "failed", claimToken: null,
      payload: { ...(job.payload as object), decision: { reason: "rejected", message: "legacy provider secret: sk-test-sensitive" } },
    } })
    expect(await settleAbandonedDeliveries({ organizationIds: [org.organizationId] })).toMatchObject({ settled: 1, failed: 0 })
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice.lastEmailAttemptMessage).toBe("The email provider refused the email. Check the email configuration.")
    expect((await deliveryJob(org.organizationId)).result).toMatchObject({ outcome: "rejected", code: "email_provider_refused", message: invoice.lastEmailAttemptMessage })
    expect(JSON.stringify(await readActivity({ organizationId: org.organizationId, aggregateId: invoiceId }))).not.toContain("sk-test-sensitive")
  })

  it("replays the identical stored message and key after an uncertain failure", async () => {
    const { org, invoiceId, contactId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("application_error", "fetch failed"))

    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })

    const frozen = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(frozen).toMatchObject({ status: "draft", lastEmailAttemptOutcome: "sending" })
    const blocked = await executeIssuanceCommand(
      updateInvoiceDraft,
      { id: invoiceId, notes: "Changed while sending" },
      { actor: org.actors.admin }
    )
    expect(blocked).toMatchObject({ status: "failed", error: { code: "send_in_progress" } })

    // Changing the contact before the retry must not change what is delivered.
    await prisma.contact.update({ where: { id: contactId }, data: { email: "someone-else@acme.test" } })
    const job = await deliveryJob(org.organizationId)
    expect(job.status).toBe("pending")
    await makeDue(job.id)
    await runDueJobs({ organizationIds: [org.organizationId] })

    expect(deliver).toHaveBeenCalledTimes(2)
    const [first, second] = vi.mocked(deliver).mock.calls
    expect(second).toEqual(first)
    expect(first?.[0]).toMatchObject({ to: "billing@acme.test" })
    expect(first?.[1]?.idempotencyKey).toMatch(new RegExp(`^invoice-send:${invoiceId}:\\d+$`))
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "sent" })
    expect(invoice.issueDate.getTime()).toBe(frozen.lastEmailAttemptAt?.getTime())
  })

  it("issues an invoice whose delivery was never confirmed, marked unconfirmed, never reopened", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValue(new Error("socket hang up"))

    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    const job = await deliveryJob(org.organizationId)
    await prisma.job.update({ where: { id: job.id }, data: { attempts: EMAIL_DELIVERY_ATTEMPTS - 1 } })
    await makeDue(job.id)
    const sweep = await runDueJobs({ organizationIds: [org.organizationId] })

    expect(sweep).toMatchObject({ failed: 1, succeeded: 0 })
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({
      status: "sent",
      lastEmailAttemptOutcome: "unconfirmed",
      lastEmailAttemptCode: "delivery_unconfirmed",
    })
    expect(await deliveryJob(org.organizationId)).toMatchObject({ status: "failed", result: { outcome: "unconfirmed" } })
  })

  it("treats a refusal after an uncertain attempt as unconfirmed, not as nothing delivered", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver)
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new EmailSendError("invalid_api_key", "API key is invalid"))

    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    await makeDue((await deliveryJob(org.organizationId)).id)
    await runDueJobs({ organizationIds: [org.organizationId] })

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "unconfirmed" })
  })

  it("stops retrying once the provider no longer honors the idempotency key", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("socket hang up"))

    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    const job = await deliveryJob(org.organizationId)
    await prisma.$executeRaw`UPDATE "job" SET "createdAt" = NOW() - INTERVAL '25 hours' WHERE "id" = ${job.id}`
    await makeDue(job.id)
    await runDueJobs({ organizationIds: [org.organizationId] })

    expect(deliver).toHaveBeenCalledTimes(1)
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "unconfirmed" })
  })

  it("settles an accepted email without sending again when settling first failed", async () => {
    const { org, invoiceId } = await setup()
    // The provider accepted the message and that was recorded, but settling the invoice failed.
    vi.mocked(deliver).mockRejectedValueOnce(new Error("socket hang up"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    const queued = await deliveryJob(org.organizationId)
    await prisma.job.update({
      where: { id: queued.id },
      data: { payload: { ...(queued.payload as object), providerMessageId: "email_123" } },
    })
    vi.mocked(deliver).mockClear()

    const job = await deliveryJob(org.organizationId)
    expect(job.status).toBe("pending")
    expect(job.payload).toMatchObject({ providerMessageId: "email_123" })
    await makeDue(job.id)
    await runDueJobs({ organizationIds: [org.organizationId] })

    expect(deliver).not.toHaveBeenCalled()
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({
      status: "sent",
      lastEmailAttemptOutcome: "sent",
    })
  })

  it("settles deliveries whose job ended without settling", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("socket hang up"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    // A runner stopped during the job's last allowed attempt; the job runner gave it up.
    const job = await deliveryJob(org.organizationId)
    await prisma.job.update({ where: { id: job.id }, data: { status: "failed", lastError: "Runner stopped" } })

    expect(await settleAbandonedDeliveries({ organizationIds: [org.organizationId] })).toMatchObject({ settled: 1 })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({
      status: "sent",
      lastEmailAttemptOutcome: "unconfirmed",
    })
    expect(await settleAbandonedDeliveries({ organizationIds: [org.organizationId] })).toMatchObject({ abandoned: 0 })
  })

  it("reports each delivery's own outcome even after a later attempt on the same document", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver)
      .mockRejectedValueOnce(new EmailSendError("validation_error", "Domain is not verified"))
      .mockRejectedValueOnce(new Error("socket hang up"))

    const first = await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    const second = await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    if (first.status !== "completed" || second.status !== "completed") throw new Error("expected sends")

    expect(await readDeliveryResult(first.result.deliveryKey!)).toMatchObject({ outcome: "rejected" })
    expect(await readDeliveryResult(second.result.deliveryKey!)).toMatchObject({ outcome: "pending" })
  })

  it("runs emails queued by background jobs within the same sweep and counts them", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "Domain is not verified"))
    registerJobHandler("test.send_invoice", async (job) => {
      const { id } = job.payload as { id: string }
      await executeIssuanceCommand(sendInvoice, { id }, { actor: org.actors.admin })
    })
    await prisma.job.create({
      data: { organizationId: org.organizationId, type: "test.send_invoice", payload: { id: invoiceId } },
    })

    const limited = await runDueJobs({ organizationIds: [org.organizationId], limit: 1 })
    expect(limited).toMatchObject({ processed: 1, succeeded: 1 })
    expect(deliver).not.toHaveBeenCalled()

    const sweep = await runDueJobs({ organizationIds: [org.organizationId] })
    expect(sweep).toMatchObject({ processed: 1, failed: 1 })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("never lets a delivery settle a document that is no longer waiting for it", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("socket hang up"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })

    // Another attempt owns the marker now (e.g. an operator cleared and re-sent it).
    const newer = new Date(Date.now() + 60_000)
    await prisma.invoice.update({ where: { id: invoiceId }, data: { lastEmailAttemptAt: newer } })
    const job = await deliveryJob(org.organizationId)
    await makeDue(job.id)
    await runDueJobs({ organizationIds: [org.organizationId] })

    expect(deliver).toHaveBeenCalledTimes(1)
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({ status: "draft", lastEmailAttemptOutcome: "sending" })
    expect(invoice.lastEmailAttemptAt?.getTime()).toBe(newer.getTime())
    // The superseded delivery still records an outcome, so nobody waits on it.
    expect((await deliveryJob(org.organizationId)).result).toMatchObject({ outcome: "unconfirmed" })
  })

  it("stops retrying a reminder once the invoice is paid, keeping it as possibly delivered", async () => {
    const { org, invoiceId } = await setup()
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    vi.mocked(deliver).mockClear()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("socket hang up"))

    const reminder = await executeIssuanceCommand(sendReminderNow, { invoiceId }, { actor: org.actors.admin })
    if (reminder.status !== "completed") throw new Error("expected the reminder to be queued")
    await executeIssuanceCommand(
      recordPayment,
      { invoiceId, amount: 100, paidAt: "2026-01-15", method: "bank_transfer" },
      { actor: org.actors.admin }
    )
    const job = await prisma.job.findUniqueOrThrow({ where: { dedupeKey: reminder.result.deliveryKey } })
    await makeDue(job.id)
    await runDueJobs({ organizationIds: [org.organizationId] })

    expect(deliver).toHaveBeenCalledTimes(1)
    const row = await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: reminder.result.reminderId } })
    expect(row.outcome).toBe("unconfirmed")
    expect(row.outcomeMessage).toContain("delivery not confirmed")
    expect(await readDeliveryResult(reminder.result.deliveryKey)).toMatchObject({ outcome: "unconfirmed" })
  })

  it("counts provider requests, not job claims, when deciding whether anything may have arrived", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("socket hang up"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    // Earlier claims that never reached the provider (e.g. a database error before the request).
    const job = await deliveryJob(org.organizationId)
    const payload = job.payload as Record<string, unknown>
    await prisma.job.update({ where: { id: job.id }, data: { attempts: 3, payload: { ...payload, requests: 0 } } })
    vi.mocked(deliver).mockRejectedValueOnce(new EmailSendError("validation_error", "Domain is not verified"))
    await makeDue(job.id)
    await runDueJobs({ organizationIds: [org.organizationId] })

    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({
      status: "draft",
      lastEmailAttemptOutcome: "failed",
    })
  })

  it("does not count a delivery that could not reach the provider as possibly delivered", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("socket hang up"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    const job = await deliveryJob(org.organizationId)
    // The first request's outcome was lost; then the process restarts without an API key.
    await prisma.job.update({ where: { id: job.id }, data: { payload: { ...(job.payload as object), requests: 0 } } })
    delete process.env.RESEND_API_KEY
    await prisma.job.update({ where: { id: job.id }, data: { attempts: EMAIL_DELIVERY_ATTEMPTS - 1 } })
    await makeDue(job.id)
    vi.mocked(deliver).mockClear()
    await runDueJobs({ organizationIds: [org.organizationId] })

    expect(deliver).not.toHaveBeenCalled()
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({
      status: "draft",
      lastEmailAttemptOutcome: "failed",
    })
    expect((await deliveryJob(org.organizationId)).result).toMatchObject({ outcome: "withdrawn" })
  })

  it("treats a delivery queued before requests were counted as possibly delivered", async () => {
    const { org, invoiceId } = await setup()
    vi.mocked(deliver).mockRejectedValueOnce(new Error("socket hang up"))
    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })
    const job = await deliveryJob(org.organizationId)
    const { requests: _requests, ...legacy } = job.payload as Record<string, unknown>
    await prisma.job.update({ where: { id: job.id }, data: { payload: legacy as object } })
    await prisma.$executeRaw`UPDATE "job" SET "createdAt" = NOW() - INTERVAL '25 hours' WHERE "id" = ${job.id}`
    await makeDue(job.id)
    vi.mocked(deliver).mockClear()
    await runDueJobs({ organizationIds: [org.organizationId] })

    expect(deliver).not.toHaveBeenCalled()
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({
      status: "sent",
      lastEmailAttemptOutcome: "unconfirmed",
    })
  })

  it("ignores a stalled run that lost its claim, keeping the newer run's acceptance", async () => {
    const { org, invoiceId } = await setup()
    // While this run waits on the provider, its lease expires and another run takes the job,
    // gets the email accepted, and records that; then this run's late refusal arrives.
    vi.mocked(deliver).mockImplementationOnce(async () => {
      const job = await deliveryJob(org.organizationId)
      await prisma.job.update({
        where: { id: job.id },
        data: { claimToken: "newer-run", payload: { ...(job.payload as object), providerMessageId: "accepted-by-newer-run" } },
      })
      throw new EmailSendError("validation_error", "Late refusal")
    })

    await executeIssuanceCommand(sendInvoice, { id: invoiceId }, { actor: org.actors.admin })

    const job = await deliveryJob(org.organizationId)
    expect(job.payload).toMatchObject({ providerMessageId: "accepted-by-newer-run" })
    expect(job.result).toBeNull()
    expect(job.claimToken).toBe("newer-run")
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({
      status: "draft",
      lastEmailAttemptOutcome: "sending",
    })
  })

  /** A sent invoice with a due scheduled reminder whose email is queued but not yet attempted. */
  async function queuedScheduledReminder() {
    const ctx = await setup()
    await executeIssuanceCommand(sendInvoice, { id: ctx.invoiceId }, { actor: ctx.org.actors.admin })
    await executeIssuanceCommand(updateReminderPolicy, { enabled: true, offsetsDays: [0] }, { actor: ctx.org.actors.admin })
    const reminder = await prisma.invoiceReminder.create({
      data: { invoiceId: ctx.invoiceId, offsetDays: 0, scheduledFor: new Date(Date.now() - 1000) },
    })
    await prisma.job.create({
      data: {
        organizationId: ctx.org.organizationId,
        type: REMINDER_SEND_JOB,
        payload: { reminderId: reminder.id },
        dedupeKey: `reminder:${reminder.id}`,
      },
    })
    vi.mocked(deliver).mockClear()
    // The reminder job queues the email; the limit leaves the email for the next sweep.
    await runDueJobs({ organizationIds: [ctx.org.organizationId], limit: 1 })
    expect(await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: reminder.id } })).toMatchObject({
      outcome: "sending",
    })
    return { ...ctx, reminderId: reminder.id }
  }

  it("withdraws a queued scheduled reminder once automatic reminders are turned off", async () => {
    const { org, reminderId } = await queuedScheduledReminder()
    await executeIssuanceCommand(updateReminderPolicy, { enabled: false, offsetsDays: [0] }, { actor: org.actors.admin })

    await runDueJobs({ organizationIds: [org.organizationId] })

    expect(deliver).not.toHaveBeenCalled()
    expect(await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: reminderId } })).toMatchObject({
      outcome: "skipped",
      outcomeMessage: POLICY_DISABLED_MESSAGE,
    })
  })

  it("re-queues a scheduled reminder with the current balance after a partial payment", async () => {
    const { org, invoiceId, reminderId } = await queuedScheduledReminder()
    await executeIssuanceCommand(
      recordPayment,
      { invoiceId, amount: 40, paidAt: "2026-01-15", method: "bank_transfer" },
      { actor: org.actors.admin }
    )

    await runDueJobs({ organizationIds: [org.organizationId] })

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deliver).mock.calls[0]?.[0].html).toContain("60.00")
    expect(await prisma.invoiceReminder.findUniqueOrThrow({ where: { id: reminderId } })).toMatchObject({
      outcome: "sent",
    })
  })

  describe("approved agent sends", () => {
    async function queued() {
      const ctx = await setup()
      const { secret } = await createAgentKey(ctx.org.actors.admin, {
        name: "Bookkeeper",
        mode: "approval_required",
        scopes: ["invoice:send", "invoice:update", "invoice:read"],
      })
      const agent = await authenticateAgentSecret(secret)
      const request = await executeIssuanceCommand(sendInvoice, { id: ctx.invoiceId }, { actor: agent, clientRequestId: "s1" })
      if (request.status !== "awaiting_approval") throw new Error("expected approval")
      return { ...ctx, agent, request }
    }

    it("records the delivery as the agent, approved by the reviewer", async () => {
      const { org, invoiceId, request, agent } = await queued()

      const decided = await decideApproval({
        approvalRequestId: request.approvalRequestId,
        decider: org.actors.admin,
        decision: "approve",
      })

      expect(decided.status).toBe("completed")
      const sent = await prisma.domainEvent.findFirstOrThrow({
        where: { organizationId: org.organizationId, aggregateId: invoiceId, type: "invoice.sent" },
      })
      expect(sent).toMatchObject({
        actorKind: "agent",
        actorId: agent.agentKeyId,
        approvedByUserId: org.actors.admin.userId,
        commandId: request.commandId,
      })
    })

    it("leaves the draft untouched when the document changed since review", async () => {
      const { org, invoiceId, request, agent } = await queued()
      await executeIssuanceCommand(updateInvoiceDraft, { id: invoiceId, notes: "Edited after queuing" }, { actor: agent })

      const decided = await decideApproval({
        approvalRequestId: request.approvalRequestId,
        decider: org.actors.admin,
        decision: "approve",
      })

      expect(decided).toMatchObject({ status: "failed", error: { code: "changed_since_review" } })
      expect(deliver).not.toHaveBeenCalled()
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
      expect(invoice).toMatchObject({ status: "draft", lastEmailAttemptOutcome: null })
      const receipt = await prisma.commandReceipt.findUniqueOrThrow({ where: { id: request.commandId } })
      expect(receipt.status).toBe("failed")
    })
  })
})
