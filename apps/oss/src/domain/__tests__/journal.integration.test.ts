import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { createRequestContext } from "../../trpc/init"
import { journalRouter } from "../../trpc/routers/journal"
import { actorKey, type UserActor } from "../actor"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../lib/email", async () => ({
  ...(await vi.importActual<typeof import("../../lib/email")>(
    "../../lib/email"
  )),
  deliver: vi.fn().mockResolvedValue({ id: "accepted_1" })
}))
import { executeIssuanceCommand } from "../../application/issuance"
import { getPrisma, prisma } from "../../lib/db"
import { deliver, EmailSendError } from "../../lib/email"
import { getPublicInvoicePaymentUrl } from "../../lib/payments/public"
import { getPublicQuoteUrl } from "../../lib/quotes/public-url"
import {
  resetRuntimeServices,
  setRuntimeServices
} from "../../lib/runtime/services"
import { Prisma } from "../../../generated/prisma/client"
import { defaultNodePlatform } from "../../lib/runtime/node-platform"
import {
  resetRuntimePlatform,
  setRuntimePlatform
} from "../../lib/runtime/platform"
import {
  createTestOrganization,
  hasTestDatabase
} from "../../test-utils/organization"
import { authenticateAgentSecret, createAgentKey } from "../agent-keys"
import { createContact } from "../commands/contacts"
import {
  createInvoiceDraft,
  resendInvoiceEmail,
  sendInvoice
} from "../commands/invoices"
import { createQuoteDraft, sendQuote } from "../commands/quotes"
import {
  documentJournal,
  manualResendCommand,
  reconcileDelivery,
  recoverDelivery
} from "../delivery/journal"
import { EMAIL_DELIVERY_JOB } from "../delivery/outbox"
import { executeCommand } from "../execute"
import { runDueJobs, runJobsNow } from "../jobs"
import { appRouter } from "../../trpc/router"

const suite = hasTestDatabase ? describe : describe.skip
suite("operation journal and bounded recovery", () => {
  const cleanup: Array<() => Promise<void>> = []
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "synthetic_test_key")
    vi.stubEnv("FROM_EMAIL", "sender@example.test")
    vi.stubEnv("EMAIL_PROVIDER", "resend")
    vi.mocked(deliver).mockReset()
    vi.mocked(deliver).mockResolvedValue({ id: "accepted_1" })
  })
  afterEach(async () => {
    resetRuntimePlatform()
    while (cleanup.length) await cleanup.pop()?.()
    vi.unstubAllEnvs()
    resetRuntimeServices()
  })
  async function setup() {
    const org = await createTestOrganization({ roles: ["admin", "accountant"] })
    cleanup.push(org.cleanup)
    const actor = org.actors.admin
    const contact = await executeCommand(
      createContact,
      { name: "Journal customer", email: "recipient@example.test" },
      { actor }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const requestId = crypto.randomUUID()
    const input = {
      contactId: contact.result.id,
      dueDate: "2099-12-01",
      taxRate: 0,
      items: [{ description: "Consulting", quantity: 1, unitPrice: 100 }]
    }
    const created = await executeCommand(createInvoiceDraft, input, {
      actor,
      clientRequestId: requestId
    })
    if (created.status !== "completed") throw new Error("invoice setup failed")
    const scope = {
      documentType: "invoice" as const,
      documentId: created.result.id
    }
    return { org, actor, scope, created, input, requestId }
  }
  function beforeJobWrite(before: (args: Prisma.JobUpdateManyArgs) => void) {
    const extended = getPrisma().$extends({
      query: {
        job: {
          updateMany({ args, query }) {
            before(args)
            return query(args)
          }
        }
      }
    })
    setRuntimePlatform({ ...defaultNodePlatform, getPrisma: () => extended })
  }
  const findJob = (organizationId: string) =>
    prisma.job.findFirstOrThrow({
      where: { organizationId, type: EMAIL_DELIVERY_JOB },
      orderBy: { createdAt: "asc" }
    })
  async function uncertain(paymentLink = false, publicLinkVersion = 1) {
    const context = await setup()
    await prisma.invoice.update({
      where: { id: context.scope.documentId },
      data: { publicPaymentKeyVersion: publicLinkVersion }
    })
    if (paymentLink)
      await prisma.orgSettings.update({
        where: { organizationId: context.actor.organizationId },
        data: {
          stripePublishableKey: "pk_test_fixture",
          stripeSecretKeyEnc: "synthetic_encrypted_key",
          stripeWebhookSecretEnc: "synthetic_encrypted_webhook"
        }
      })
    vi.stubEnv("EMAIL_PROVIDER", "smtp")
    vi.stubEnv("SMTP_HOST", "relay.example.test")
    vi.mocked(deliver).mockRejectedValueOnce(
      new Error("Response lost after possible SMTP acceptance")
    )
    await executeIssuanceCommand(
      sendInvoice,
      { id: context.scope.documentId },
      { actor: context.actor, clientRequestId: "send-original" }
    )
    const job = await findJob(context.org.organizationId)
    return {
      ...context,
      job,
      delivery: { ...context.scope, deliveryId: job.id }
    }
  }
  it("retains the created record and receipt after a caller interruption, and recovers only a never-submitted outbox step", async () => {
    const { actor, scope, created, requestId, input, org } = await setup()
    // A caller loses its response after creation commits. The same request returns the same record.
    const retried = await executeCommand(createInvoiceDraft, input, {
      actor,
      clientRequestId: requestId
    })
    expect(retried).toMatchObject({
      status: "completed",
      result: { id: scope.documentId }
    })
    expect(
      await prisma.invoice.count({
        where: { organizationId: org.organizationId }
      })
    ).toBe(1)
    expect((await documentJournal(actor, scope)).commands).toContainEqual(
      expect.objectContaining({
        id: created.commandId,
        state: "effects_completed",
        steps: expect.arrayContaining([
          expect.objectContaining({ type: "invoice.draft_created" })
        ])
      })
    )
    // Interrupt the job before its durable pre-request marker. The command transaction
    // has committed its receipt, candidate and outbox together, but no provider was called.
    let stop = true
    beforeJobWrite((args) => {
      if (
        stop &&
        (args.data as { payload?: { requests?: number } }).payload?.requests ===
          1
      ) {
        stop = false
        throw new Error("interrupted before submission")
      }
    })
    await executeIssuanceCommand(
      sendInvoice,
      { id: scope.documentId },
      { actor, clientRequestId: "queued-send" }
    )
    resetRuntimePlatform()
    const job = await findJob(org.organizationId)
    expect(vi.mocked(deliver)).not.toHaveBeenCalled()
    expect((await documentJournal(actor, scope)).deliveries[0]).toMatchObject({
      canRecover: true,
      state: "queued"
    })
    await recoverDelivery(actor, { ...scope, deliveryId: job.id })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
    expect(
      await prisma.invoice.count({
        where: { organizationId: org.organizationId }
      })
    ).toBe(1)
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: org.organizationId,
          type: "invoice.draft_created"
        }
      })
    ).toBe(1)
  })
  it.each(["accepted", "rejected"] as const)(
    "recovers settlement after %s evidence without calling the provider or issuing twice",
    async (outcome) => {
      const { actor, scope, org } = await setup()
      const base = getPrisma()
      let stopSettlement = false
      setRuntimePlatform({
        ...defaultNodePlatform,
        getPrisma: () =>
          new Proxy(base, {
            get(target, property) {
              if (property === "$transaction")
                return (...args: unknown[]) => {
                  if (stopSettlement) {
                    stopSettlement = false
                    return Promise.reject(new Error("settlement interrupted"))
                  }
                  return Reflect.apply(target.$transaction, target, args)
                }
              const value = Reflect.get(target, property)
              return typeof value === "function" ? value.bind(target) : value
            }
          })
      })
      vi.mocked(deliver).mockImplementationOnce(async () => {
        stopSettlement = true
        if (outcome === "rejected")
          throw new EmailSendError("validation_error", "refused submission")
        return { id: "accepted_1" }
      })
      await executeIssuanceCommand(
        sendInvoice,
        { id: scope.documentId },
        { actor, clientRequestId: "acceptance-stored" }
      )
      resetRuntimePlatform()
      const job = await findJob(org.organizationId)
      expect(job.payload).toMatchObject(
        outcome === "accepted"
          ? { providerMessageId: "accepted_1", requests: 1 }
          : { decision: { reason: "rejected" }, requests: 1 }
      )
      expect((await documentJournal(actor, scope)).deliveries[0]?.state).toBe(
        outcome === "accepted" ? "delivery_confirmed" : "failed_step"
      )
      expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
      await recoverDelivery(actor, { ...scope, deliveryId: job.id })
      expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
      expect(
        await prisma.invoice.findUniqueOrThrow({
          where: { id: scope.documentId }
        })
      ).toMatchObject({ status: outcome === "accepted" ? "sent" : "draft" })
      expect(
        await prisma.domainEvent.count({
          where: { organizationId: org.organizationId, type: "invoice.sent" }
        })
      ).toBe(outcome === "accepted" ? 1 : 0)
      await runJobsNow([job.id])
      expect(
        await prisma.domainEvent.count({
          where: { organizationId: org.organizationId, type: "invoice.sent" }
        })
      ).toBe(outcome === "accepted" ? 1 : 0)
    }
  )
  it("distinguishes missing configuration from a delivery failure", async () => {
    const { actor, scope, org } = await setup()
    beforeJobWrite((args) => {
      if ((args.data as { status?: string }).status === "running")
        vi.stubEnv("RESEND_API_KEY", "")
    })
    await executeIssuanceCommand(
      sendInvoice,
      { id: scope.documentId },
      { actor, clientRequestId: "wait-for-config" }
    )
    resetRuntimePlatform()
    const job = await findJob(org.organizationId)
    expect((await documentJournal(actor, scope)).deliveries[0]).toMatchObject({
      state: "waiting_prerequisite",
      canRecover: true
    })
    expect(vi.mocked(deliver)).not.toHaveBeenCalled()
    vi.stubEnv("RESEND_API_KEY", "synthetic_test_key")
    await recoverDelivery(actor, { ...scope, deliveryId: job.id })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
  })
  it("joins a failed business step and an approval prerequisite even when neither emitted a document event", async () => {
    const { actor, scope } = await setup()
    const failed = await executeCommand(
      resendInvoiceEmail,
      { id: scope.documentId },
      { actor }
    )
    expect(failed.status).toBe("failed")
    expect((await documentJournal(actor, scope)).commands).toContainEqual(
      expect.objectContaining({
        id: failed.commandId,
        type: "invoice.resend_email",
        state: "failed_step",
        steps: []
      })
    )
    const { secret } = await createAgentKey(actor, {
      name: "Approval operator",
      mode: "approval_required",
      scopes: ["invoice:read", "invoice:send"]
    })
    const agent = await authenticateAgentSecret(secret)
    if (!agent) throw new Error("Agent authentication failed")
    const waiting = await executeIssuanceCommand(
      sendInvoice,
      { id: scope.documentId },
      { actor: agent, clientRequestId: "waiting-send" }
    )
    expect(waiting.status).toBe("awaiting_approval")
    expect((await documentJournal(actor, scope)).commands).toContainEqual(
      expect.objectContaining({
        id: waiting.commandId,
        type: "invoice.send",
        state: "waiting_prerequisite",
        steps: []
      })
    )
    expect(vi.mocked(deliver)).not.toHaveBeenCalled()
  })
  it("rolls back an interrupted creation and records only the successful retry", async () => {
    const { actor, input, org } = await setup()
    const extended = getPrisma().$extends({
      query: {
        invoice: {
          async create({ args, query }) {
            await query(args)
            throw new Error("creation interrupted before commit")
          }
        }
      }
    })
    setRuntimePlatform({ ...defaultNodePlatform, getPrisma: () => extended })
    await expect(
      executeCommand(createInvoiceDraft, input, {
        actor,
        clientRequestId: "creation-interrupted"
      })
    ).rejects.toThrow("creation interrupted before commit")
    resetRuntimePlatform()
    expect(
      await prisma.invoice.count({
        where: { organizationId: org.organizationId }
      })
    ).toBe(1)
    expect(
      await prisma.commandReceipt.count({
        where: {
          organizationId: org.organizationId,
          clientRequestId: "creation-interrupted"
        }
      })
    ).toBe(0)
    const created = await executeCommand(createInvoiceDraft, input, {
      actor,
      clientRequestId: "creation-interrupted"
    })
    expect(created.status).toBe("completed")
    expect(
      await executeCommand(createInvoiceDraft, input, {
        actor,
        clientRequestId: "creation-interrupted"
      })
    ).toEqual(created)
    expect(
      await prisma.invoice.count({
        where: { organizationId: org.organizationId }
      })
    ).toBe(2)
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: org.organizationId,
          type: "invoice.draft_created"
        }
      })
    ).toBe(2)
  })
  it("keeps SMTP uncertainty visible and forbids automatic and unacknowledged resends", async () => {
    const { actor, scope, job, delivery } = await uncertain()
    const journal = await documentJournal(actor, scope)
    expect(journal.deliveries[0]).toMatchObject({
      state: "uncertain",
      recipient: "recipient@example.test",
      canRecover: false,
      canManualResend: true,
      attempts: [{ outcome: "uncertain", startedAt: expect.any(String) }]
    })
    await expect(recoverDelivery(actor, delivery)).rejects.toMatchObject({
      code: "unsafe_retry"
    })
    const normal = await executeCommand(
      resendInvoiceEmail,
      { id: scope.documentId },
      { actor }
    )
    expect(normal).toMatchObject({
      status: "failed",
      error: { code: "manual_resend_required" }
    })
    const unacknowledged = await executeCommand(
      manualResendCommand("invoice"),
      {
        ...delivery,
        reviewedTarget: journal.deliveries[0]!.manualTarget,
        reason: "verified",
        clientRequestId: "manual-1"
      },
      { actor }
    )
    expect(unacknowledged.status).toBe("failed")
    await runDueJobs({ organizationIds: [actor.organizationId] })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
    expect(job.result).toMatchObject({ outcome: "unconfirmed" })
  })
  it("records one manual decision, sends the stored communication for the same invoice, and replays its receipt", async () => {
    const { actor, scope, job, delivery } = await uncertain()
    vi.mocked(deliver).mockResolvedValue({ id: "manual_accepted" })
    const input = {
      ...delivery,
      reviewedTarget: (await documentJournal(actor, scope)).deliveries[0]!
        .manualTarget,
      reason: "Recipient checked and requested another copy",
      acknowledgeDuplicateRisk: true as const,
      clientRequestId: "manual-1"
    }
    const decision = manualResendCommand("invoice")
    const result = await executeCommand(decision, input, {
      actor,
      clientRequestId: input.clientRequestId
    })
    expect(result.status).toBe("completed")
    expect(
      await executeCommand(decision, input, {
        actor,
        clientRequestId: input.clientRequestId
      })
    ).toEqual(result)
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deliver).mock.calls[1]?.[0]).toEqual(
      (job.payload as { message: unknown }).message
    )
    expect(
      await prisma.invoice.count({
        where: { organizationId: actor.organizationId }
      })
    ).toBe(1)
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: actor.organizationId,
          type: "invoice.draft_created"
        }
      })
    ).toBe(1)
    expect(
      await prisma.domainEvent.count({
        where: { organizationId: actor.organizationId, type: "invoice.sent" }
      })
    ).toBe(0)
    expect(
      await prisma.domainEvent.count({
        where: { organizationId: actor.organizationId, type: "invoice.issued" }
      })
    ).toBe(1)
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: actor.organizationId,
          type: "delivery.manual_resend_requested"
        }
      })
    ).toBe(1)
    expect((await documentJournal(actor, scope)).deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recoveryOf: job.id,
          manualReason: input.reason
        }),
        expect.objectContaining({
          id: job.id,
          state: "uncertain",
          canManualResend: false
        })
      ])
    )
    expect(
      (
        await executeCommand(
          decision,
          { ...input, clientRequestId: "manual-2" },
          { actor, clientRequestId: "manual-2" }
        )
      ).status
    ).toBe("failed")
  })
  it("applies repeated and out-of-order status evidence monotonically and leaves unknown unresolved", async () => {
    const { actor, scope, delivery } = await uncertain()
    const lookup = vi.fn().mockResolvedValue({
      evidenceId: "lookup-1",
      observedAt: new Date(),
      outcome: "unknown"
    })
    setRuntimeServices({
      emailDeliveryStatusProvider: { supports: () => true, lookup }
    })
    await reconcileDelivery(actor, delivery)
    await reconcileDelivery(actor, delivery)
    expect((await documentJournal(actor, scope)).deliveries[0]).toMatchObject({
      state: "uncertain",
      evidence: [{ outcome: "unknown" }]
    })
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: actor.organizationId,
          type: "delivery.provider_evidence"
        }
      })
    ).toBe(1)
    lookup.mockResolvedValue({
      evidenceId: "lookup-2",
      observedAt: new Date(),
      outcome: "accepted",
      providerMessageId: "smtp-evidence"
    })
    await reconcileDelivery(actor, delivery)
    await reconcileDelivery(actor, delivery)
    lookup.mockResolvedValue({
      evidenceId: "old-unknown",
      observedAt: new Date(0),
      outcome: "unknown"
    })
    await reconcileDelivery(actor, delivery)
    expect((await documentJournal(actor, scope)).deliveries[0]).toMatchObject({
      state: "delivery_confirmed",
      providerReference: "smtp-evidence",
      canManualResend: false
    })
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: actor.organizationId,
          type: "delivery.provider_evidence"
        }
      })
    ).toBe(2)
    expect(
      await prisma.invoice.findUniqueOrThrow({
        where: { id: scope.documentId }
      })
    ).toMatchObject({ status: "sent", lastEmailAttemptOutcome: "sent" })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
  })
  it("fences a stopped SMTP runner before recovery, including a request with no recorded answer", async () => {
    const { actor, scope, org } = await setup()
    // Crash after the provider effect, before recording acceptance. The persisted started
    // marker must force uncertainty and must not cause another SMTP submission.
    beforeJobWrite((args) => {
      if (
        (args.data as { payload?: { providerMessageId?: string } }).payload
          ?.providerMessageId
      )
        throw new Error("process stopped before acceptance write")
    })
    vi.stubEnv("EMAIL_PROVIDER", "smtp")
    vi.stubEnv("SMTP_HOST", "relay.example.test")
    await executeIssuanceCommand(
      sendInvoice,
      { id: scope.documentId },
      { actor, clientRequestId: "crashed-smtp" }
    )
    resetRuntimePlatform()
    const job = await findJob(org.organizationId)
    await recoverDelivery(actor, { ...scope, deliveryId: job.id }).catch(
      (error) => expect(error).toMatchObject({ code: "unsafe_retry" })
    )
    await prisma.job.update({
      where: { id: job.id },
      data: { runAfter: new Date(0) }
    })
    await runDueJobs({ organizationIds: [org.organizationId] })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
    expect((await documentJournal(actor, scope)).deliveries[0]?.state).toBe(
      "uncertain"
    )
  })
  it("does not replay a revoked public link or change a newer delivery marker when old evidence arrives", async () => {
    const { actor, scope, delivery } = await uncertain()
    await prisma.invoice.update({
      where: { id: scope.documentId },
      data: { publicPaymentKeyVersion: { increment: 1 } }
    })
    expect(
      (await documentJournal(actor, scope)).deliveries[0]?.canManualResend
    ).toBe(false)
    const refused = await executeCommand(
      manualResendCommand("invoice"),
      {
        ...delivery,
        reviewedTarget: (await documentJournal(actor, scope)).deliveries[0]!
          .manualTarget,
        reason: "Recipient asked",
        acknowledgeDuplicateRisk: true,
        clientRequestId: "revoked-send"
      },
      { actor, clientRequestId: "revoked-send" }
    )
    expect(refused).toMatchObject({
      status: "failed",
      error: { code: "manual_resend_unavailable" }
    })
    const newer = new Date("2099-01-01T00:00:00Z")
    await prisma.invoice.update({
      where: { id: scope.documentId },
      data: { lastEmailAttemptAt: newer, lastEmailAttemptOutcome: "sending" }
    })
    setRuntimeServices({
      emailDeliveryStatusProvider: {
        supports: () => true,
        lookup: async () => ({
          evidenceId: "old-confirmation",
          observedAt: new Date(),
          outcome: "accepted",
          providerMessageId: "old-message"
        })
      }
    })
    await reconcileDelivery(actor, delivery)
    expect(
      await prisma.invoice.findUniqueOrThrow({
        where: { id: scope.documentId }
      })
    ).toMatchObject({
      lastEmailAttemptAt: newer,
      lastEmailAttemptOutcome: "sending"
    })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
  })
  it("replaces an uncertain revoked-link email through an audited current-document decision without issuing again", async () => {
    const { actor, scope, delivery, job } = await uncertain(true)
    const before = await prisma.invoice.findUniqueOrThrow({
      where: { id: scope.documentId }
    })
    await prisma.invoice.update({
      where: { id: before.id },
      data: { publicPaymentKeyVersion: { increment: 1 } }
    })
    const reviewed = (await documentJournal(actor, scope)).deliveries[0]!
    expect(reviewed.canManualResend).toBe(false)
    expect(reviewed.canReplaceEmail).toBe(true)
    const input = {
      ...delivery,
      mode: "replacement" as const,
      reviewedTarget: reviewed.replacementTarget!,
      reason:
        "Recipient verified the old link was revoked and requested the current copy",
      acknowledgeDuplicateRisk: true as const,
      clientRequestId: "replace-revoked"
    }
    const normal = await executeCommand(
      resendInvoiceEmail,
      { id: before.id },
      { actor }
    )
    expect(normal).toMatchObject({
      status: "failed",
      error: { code: "manual_resend_required" }
    })
    const decision = manualResendCommand("invoice")
    const result = await executeCommand(decision, input, {
      actor,
      clientRequestId: input.clientRequestId
    })
    expect(result.status).toBe("completed")
    expect(
      await executeCommand(decision, input, {
        actor,
        clientRequestId: input.clientRequestId
      })
    ).toEqual(result)
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(2)
    const replacement = await prisma.job.findFirstOrThrow({
      where: {
        organizationId: actor.organizationId,
        payload: { path: ["recoveryOf"], equals: job.id }
      }
    })
    expect(replacement.payload).toMatchObject({
      recoveryOf: job.id,
      manualReason: input.reason,
      completion: {
        kind: "invoice.email",
        target: {
          publicLinkKeyVersion: "2",
          recipient: input.reviewedTarget.recipient
        }
      }
    })
    expect(vi.mocked(deliver).mock.calls[1]?.[0]).not.toEqual(
      (job.payload as { message: unknown }).message
    )
    const after = await prisma.invoice.findUniqueOrThrow({
      where: { id: before.id }
    })
    expect(vi.mocked(deliver).mock.calls[1]?.[0].html).toContain(
      getPublicInvoicePaymentUrl(after)!
    )
    expect(vi.mocked(deliver).mock.calls[1]?.[0].html).not.toContain(
      getPublicInvoicePaymentUrl(before)!
    )
    expect(replacement.payload).toMatchObject({
      manualReview: { mode: "replacement", ...input.reviewedTarget }
    })
    expect(
      await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    ).toMatchObject({ result: { outcome: "unconfirmed" } })
    expect(
      await prisma.invoice.findUniqueOrThrow({ where: { id: before.id } })
    ).toMatchObject({
      number: before.number,
      issueDate: before.issueDate,
      status: before.status
    })
    expect(
      await prisma.invoice.count({
        where: { organizationId: actor.organizationId }
      })
    ).toBe(1)
    expect(
      await prisma.domainEvent.count({
        where: { organizationId: actor.organizationId, type: "invoice.issued" }
      })
    ).toBe(1)
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: actor.organizationId,
          type: "delivery.manual_resend_requested"
        }
      })
    ).toBe(1)
  })
  it.each(["document", "recipient", "link"] as const)(
    "refuses a replacement when the reviewed %s changes",
    async (changed) => {
      const { actor, scope, delivery } = await uncertain()
      const document = await prisma.invoice.update({
        where: { id: scope.documentId },
        data: { publicPaymentKeyVersion: 2 }
      })
      const reviewedTarget = (await documentJournal(actor, scope))
        .deliveries[0]!.replacementTarget!
      if (changed === "recipient")
        await prisma.contact.update({
          where: { id: document.contactId },
          data: { email: "changed@example.test" }
        })
      else
        await prisma.invoice.update({
          where: { id: document.id },
          data:
            changed === "link"
              ? { publicPaymentKeyVersion: 3 }
              : { notes: "Changed after review" }
        })
      const result = await executeCommand(
        manualResendCommand("invoice"),
        {
          ...delivery,
          mode: "replacement",
          reviewedTarget,
          reason: "Recipient checked",
          acknowledgeDuplicateRisk: true,
          clientRequestId: "stale-replacement"
        },
        { actor }
      )
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "delivery_changed" }
      })
      expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
      expect(
        await prisma.job.count({
          where: {
            organizationId: actor.organizationId,
            type: EMAIL_DELIVERY_JOB
          }
        })
      ).toBe(1)
      expect(
        await prisma.domainEvent.count({
          where: {
            organizationId: actor.organizationId,
            type: "delivery.manual_resend_requested"
          }
        })
      ).toBe(0)
    }
  )
  it("preserves version 2 on a copied message that becomes uncertain and permits reviewing its own recovery", async () => {
    const { actor, scope, delivery, job } = await uncertain(true, 2)
    const target = (await documentJournal(actor, scope)).deliveries[0]!
      .manualTarget
    vi.mocked(deliver).mockRejectedValueOnce(
      new Error("Second response also lost")
    )
    const result = await executeCommand(
      manualResendCommand("invoice"),
      {
        ...delivery,
        reviewedTarget: target,
        reason: "Recipient verified and requested another copy",
        acknowledgeDuplicateRisk: true,
        clientRequestId: "copy-v2"
      },
      { actor }
    )
    expect(result.status).toBe("completed")
    const latest = (await documentJournal(actor, scope)).deliveries.find(
      (item) => item.recoveryOf === job.id
    )!
    expect(latest).toMatchObject({
      state: "uncertain",
      canManualResend: true,
      manualTarget: { publicLinkKeyVersion: "2" }
    })
    const copied = await prisma.job.findUniqueOrThrow({
      where: { id: latest.id }
    })
    expect(copied.payload).toMatchObject({
      completion: { target: { publicLinkKeyVersion: "2" } }
    })
    expect(vi.mocked(deliver).mock.calls[1]?.[0]).toEqual(
      (job.payload as { message: unknown }).message
    )
    const subsequent = await executeCommand(
      manualResendCommand("invoice"),
      {
        ...scope,
        deliveryId: latest.id,
        reviewedTarget: latest.manualTarget,
        reason: "Recipient verified the second attempt",
        acknowledgeDuplicateRisk: true,
        clientRequestId: "copy-v2-again"
      },
      { actor }
    )
    expect(subsequent.status).toBe("completed")
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(3)
  })
  it("replaces a revoked uncertain quote link using the normal quote renderer and retains its issuance", async () => {
    const { actor, input } = await setup()
    const created = await executeCommand(
      createQuoteDraft,
      { ...input, expiryDate: "2099-12-01" },
      { actor }
    )
    if (created.status !== "completed") throw new Error("quote setup failed")
    const scope = {
      documentType: "quote" as const,
      documentId: created.result.id
    }
    vi.stubEnv("EMAIL_PROVIDER", "smtp")
    vi.stubEnv("SMTP_HOST", "relay.example.test")
    vi.mocked(deliver).mockRejectedValueOnce(
      new Error("Quote SMTP answer lost")
    )
    expect(
      (
        await executeIssuanceCommand(
          sendQuote,
          { id: scope.documentId },
          { actor }
        )
      ).status
    ).toBe("completed")
    const before = await prisma.quote.findUniqueOrThrow({
      where: { id: scope.documentId }
    })
    const document = await prisma.quote.update({
      where: { id: before.id },
      data: { publicAccessKeyVersion: { increment: 1 } }
    })
    const source = (await documentJournal(actor, scope)).deliveries[0]!
    expect(source).toMatchObject({
      state: "uncertain",
      canManualResend: false,
      canReplaceEmail: true
    })
    const result = await executeCommand(
      manualResendCommand("quote"),
      {
        ...scope,
        deliveryId: source.id,
        mode: "replacement",
        reviewedTarget: source.replacementTarget!,
        reason: "Recipient verified and requested a valid offer link",
        acknowledgeDuplicateRisk: true,
        clientRequestId: "replace-quote"
      },
      { actor }
    )
    expect(result.status).toBe("completed")
    expect(vi.mocked(deliver).mock.calls[1]?.[0].html).toContain(
      getPublicQuoteUrl(document)!
    )
    expect(vi.mocked(deliver).mock.calls[1]?.[0].html).not.toContain(
      getPublicQuoteUrl(before)!
    )
    expect(
      await prisma.quote.findUniqueOrThrow({ where: { id: before.id } })
    ).toMatchObject({
      number: before.number,
      issueDate: before.issueDate,
      status: before.status
    })
    expect(
      await prisma.quote.count({
        where: { organizationId: actor.organizationId }
      })
    ).toBe(1)
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: actor.organizationId,
          type: "quote.email_unconfirmed"
        }
      })
    ).toBe(1)
    expect(
      (
        await prisma.orgSettings.findUniqueOrThrow({
          where: { organizationId: actor.organizationId }
        })
      ).quoteNextNum
    ).toBe(2)
  })
  it("leaves a failed provider lookup unresolved and prevents recovery of a claimed delivery", async () => {
    const { actor, scope, delivery, job } = await uncertain()
    setRuntimeServices({
      emailDeliveryStatusProvider: {
        supports: () => true,
        lookup: async () => {
          throw new Error("lookup unavailable")
        }
      }
    })
    await expect(reconcileDelivery(actor, delivery)).rejects.toThrow(
      "lookup unavailable"
    )
    const response = await journalHttp(actor, "reconcile", delivery)
    expect(response.status).toBe(500)
    expect(response.text).toContain("Could not reconcile delivery")
    expect(response.text).not.toContain("lookup unavailable")
    expect((await documentJournal(actor, scope)).deliveries[0]?.state).toBe(
      "uncertain"
    )
    expect(
      await prisma.domainEvent.count({
        where: {
          organizationId: actor.organizationId,
          type: "delivery.provider_evidence"
        }
      })
    ).toBe(0)
    await prisma.job.update({
      where: { id: job.id },
      data: {
        result: Prisma.DbNull,
        status: "running",
        claimToken: "other-run"
      }
    })
    await expect(recoverDelivery(actor, delivery)).rejects.toMatchObject({
      code: "unsafe_retry"
    })
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
  })
  it("hides journal details across organizations and from an actor missing document read permission", async () => {
    const { actor, scope, org } = await setup()
    await expect(
      documentJournal({ ...actor, roles: [] }, scope)
    ).rejects.toMatchObject({ _tag: "Forbidden" })
    const stranger = await createTestOrganization({ roles: ["admin"] })
    cleanup.push(stranger.cleanup)
    const caller = appRouter.createCaller({
      session: {
        user: { id: stranger.actors.admin.userId },
        session: { activeOrganizationId: stranger.organizationId }
      }
    } as never)
    await expect(caller.journal.forDocument(scope)).rejects.toMatchObject({
      code: "NOT_FOUND"
    })
    const accountant = appRouter.createCaller({
      session: {
        user: { id: org.actors.accountant.userId },
        session: { activeOrganizationId: org.organizationId }
      }
    } as never)
    expect((await accountant.journal.forDocument(scope)).commands.length).toBe(
      1
    )
    await expect(
      accountant.journal.recover({ ...scope, deliveryId: "private-job" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
  async function holdLock(lock: (tx: Prisma.TransactionClient) => Promise<unknown>, work: () => Promise<void>) {
    let release!: () => void
    let ready!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    const acquired = new Promise<void>(resolve => { ready = resolve })
    const holder = prisma.$transaction(async tx => {
      await lock(tx)
      ready()
      await released
    }, { timeout: 20_000 })
    try {
      await Promise.race([acquired, holder.then(() => { throw new Error("Lock holder ended early") })])
      await work()
    } finally {
      release()
      await holder
    }
  }
  async function durableState(organizationId: string) {
    const where = { organizationId }
    return {
      invoices: await prisma.invoice.findMany({ where, orderBy: { id: "asc" } }),
      jobs: await prisma.job.findMany({ where, orderBy: { id: "asc" } }),
      events: await prisma.domainEvent.findMany({ where, orderBy: { id: "asc" } }),
      receipts: await prisma.commandReceipt.findMany({ where, orderBy: { id: "asc" } }),
      payments: await prisma.payment.findMany({ where, orderBy: { id: "asc" } }),
    }
  }
  async function journalHttp(actor: UserActor, path: "manualResend" | "recover" | "reconcile", input: unknown) {
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc", router: journalRouter,
      req: new Request(`http://localhost/api/trpc/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: input }) }),
      createContext: () => createRequestContext({
        user: { id: actor.userId, name: "Operator", email: "operator@example.test" },
        session: { activeOrganizationId: actor.organizationId },
      } as never, actor.organizationId),
    })
    return { status: response.status, text: await response.text() }
  }
  it.each(["advisory", "contact"] as const)("rolls back a manual resend blocked on %s, then retries and replays once", async kind => {
    const { actor, scope, delivery } = await uncertain()
    const reviewed = (await documentJournal(actor, scope)).deliveries[0]
    const requestId = `timeout-${kind}`
    const input = { ...delivery, mode: "stored", reviewedTarget: reviewed.manualTarget, reason: "Recipient requested another copy", acknowledgeDuplicateRisk: true, clientRequestId: requestId }
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: scope.documentId } })
    const before = await durableState(actor.organizationId)
    await holdLock(tx => kind === "advisory"
      ? tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}|${actorKey(actor)}|${requestId}`}, 0))`
      : tx.$queryRaw`SELECT id FROM contact WHERE id = ${invoice.contactId} FOR UPDATE`, async () => {
      const started = performance.now()
      const response = await journalHttp(actor, "manualResend", input)
      expect(response.status).toBe(500)
      expect(response.text).toContain("Could not resend document")
      expect(response.text).not.toMatch(/Prisma|55P03|P2010|lock timeout|SELECT|contact/)
      expect(performance.now() - started).toBeLessThan(10_000)
      expect(await durableState(actor.organizationId)).toEqual(before)
    })
    expect((await journalHttp(actor, "manualResend", input)).status).toBe(200)
    expect((await journalHttp(actor, "manualResend", input)).status).toBe(200)
    expect(await prisma.invoice.count({ where: { organizationId: actor.organizationId } })).toBe(1)
    expect(await prisma.domainEvent.count({ where: { organizationId: actor.organizationId, type: "delivery.manual_resend_requested" } })).toBe(1)
    expect(await prisma.commandReceipt.count({ where: { organizationId: actor.organizationId, clientRequestId: requestId } })).toBe(1)
    expect(await prisma.job.count({ where: { organizationId: actor.organizationId, type: EMAIL_DELIVERY_JOB } })).toBe(2)
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(2)
  })
  it.each(["recover", "reconcile"] as const)("rolls back %s on an organization row timeout and retries only its step", async path => {
    const { actor, scope, delivery, job } = await uncertain()
    if (path === "recover") {
      // Acceptance is durable but completion was interrupted: recovery must never send again.
      await prisma.job.update({ where: { id: job.id }, data: { payload: { ...(job.payload as Prisma.JsonObject), providerMessageId: "known-accepted" }, result: Prisma.DbNull } })
    } else {
      setRuntimeServices({ emailDeliveryStatusProvider: { supports: () => true, lookup: async () => ({ evidenceId: "timeout-evidence", observedAt: new Date("2026-10-09T00:00:00Z"), outcome: "accepted", providerMessageId: "known-accepted" }) } })
    }
    const before = await durableState(actor.organizationId)
    await holdLock(tx => tx.$queryRaw`SELECT id FROM org_settings WHERE "organizationId" = ${actor.organizationId} FOR UPDATE`, async () => {
      const response = await journalHttp(actor, path, delivery)
      expect(response.status).toBe(500)
      expect(response.text).toContain(path === "recover" ? "Could not recover delivery" : "Could not reconcile delivery")
      expect(response.text).not.toMatch(/Prisma|55P03|P2010|lock timeout|SELECT/)
      expect(await durableState(actor.organizationId)).toEqual(before)
    })
    expect((await journalHttp(actor, path, delivery)).status).toBe(200)
    expect((await documentJournal(actor, scope)).deliveries[0].state).toBe("delivery_confirmed")
    expect(await prisma.invoice.count({ where: { organizationId: actor.organizationId } })).toBe(1)
    expect(vi.mocked(deliver)).toHaveBeenCalledTimes(1)
  })
  it.each(["unkeyed", "resumed"] as const)("preserves %s executor atomicity and receipt semantics under the role row bound", async mode => {
    const { actor } = await setup()
    const resumeId = `resumed-${crypto.randomUUID()}`
    if (mode === "resumed") await prisma.commandReceipt.create({ data: { id: resumeId, organizationId: actor.organizationId, actorKey: actorKey(actor), clientRequestId: resumeId, commandType: "contact.create", status: "awaiting_approval" } })
    const options = { actor, ...(mode === "resumed" ? { resumeReceiptId: resumeId } : {}) }
    const before = await durableState(actor.organizationId)
    await holdLock(tx => tx.$queryRaw`SELECT id FROM org_settings WHERE "organizationId" = ${actor.organizationId} FOR UPDATE`, async () => {
      await expect(executeCommand(createContact, { name: "Retry once" }, options)).rejects.toThrow()
      expect(await durableState(actor.organizationId)).toEqual(before)
      expect(await prisma.contact.count({ where: { organizationId: actor.organizationId, name: "Retry once" } })).toBe(0)
    })
    const outcome = await executeCommand(createContact, { name: "Retry once" }, options)
    expect(outcome.status).toBe("completed")
    expect(await prisma.commandReceipt.findUnique({ where: { id: outcome.commandId } })).toMatchObject({ status: "completed" })
    expect(await prisma.contact.count({ where: { organizationId: actor.organizationId, name: "Retry once" } })).toBe(1)
  })
})
