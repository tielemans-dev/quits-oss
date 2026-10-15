import { executeIssuanceCommand } from "../../application/issuance"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../lib/email")>("../../lib/email")
  return { ...actual, deliver: vi.fn().mockResolvedValue({ id: "email_123" }) }
})

import { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { UNDO_WINDOW_MS } from "../../lib/undo-window"
import { paymentsRouter } from "../../trpc/routers/payments"
import { deliver } from "../../lib/email"
import { findEmailDeliveryJobs } from "../../test-utils/email-outbox"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, sendInvoice } from "../commands/invoices"
import { markInvoicePaid, undoInvoiceMarkPaid } from "../commands/paid-moment"
import { recordPayment, recordStripeCheckoutPayment, voidPayment } from "../commands/payments"
import { allocateReceipt, changeReceipt, previewReceiptAllocation, previewReceiptChange, recordReceipt } from "../commands/settlements"
import { executeCommand } from "../execute"
import { receiptActionInputSchema, type ReceiptAllocateInput } from "@quits/contracts/payments"
import { runDueJobs } from "../jobs"
import "../delivery/outbox"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("payment received emails", () => {
  const cleanups: Array<() => Promise<void>> = []
  const previousEnv = { RESEND_API_KEY: process.env.RESEND_API_KEY, FROM_EMAIL: process.env.FROM_EMAIL }

  beforeEach(() => {
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"
    vi.mocked(deliver).mockReset()
    vi.mocked(deliver).mockResolvedValue({ id: "email_123" })
  })

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
    process.env.RESEND_API_KEY = previousEnv.RESEND_API_KEY
    process.env.FROM_EMAIL = previousEnv.FROM_EMAIL
  })

  /** One sent invoice totalling 250.00 (200 + 25% tax). */
  async function setup(options: { locale?: string; currency?: string } = {}) {
    const org = await createTestOrganization({
      roles: ["admin"],
      settings: { locale: options.locale, currency: options.currency ?? "USD", timezone: "Europe/Copenhagen", companyName: "Acme ApS", companyEmail: "seller@acme.test" },
    })
    cleanups.push(org.cleanup)
    const contact = await executeIssuanceCommand(
      createContact,
      { name: "Kunde & Co", email: "customer@kunde.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const draft = await executeIssuanceCommand(
      createInvoiceDraft,
      { contactId: contact.result.id, dueDate: "2099-12-01", currency: options.currency, taxRate: 25, items: [{ description: "Design", quantity: 2, unitPrice: 100 }] },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error("draft setup failed")
    const sent = await executeIssuanceCommand(sendInvoice, { id: draft.result.id, allowSendWithoutEmail: true }, { actor: org.actors.admin })
    if (sent.status !== "completed") throw new Error(`send setup failed: ${JSON.stringify(sent)}`)
    // The invoice email itself is not under test; deliver it so only payment emails remain queued.
    await runDueJobs({ organizationIds: [org.organizationId] })
    vi.mocked(deliver).mockClear()
    return { org, invoiceId: draft.result.id }
  }

  const webhook = (organizationId: string) =>
    ({ kind: "system", organizationId, reason: "stripe_webhook", label: "Stripe" }) as const

  const stripePayment = (invoiceId: string, session: string, amount: number, currency = "usd") => ({
    invoiceId, checkoutSessionId: session, paymentIntentId: `pi_${session}`, amount, currency, paidAt: "2026-06-01T22:30:00.000Z",
  })

  const queuedPaymentEmails = async (organizationId: string) =>
    (await findEmailDeliveryJobs(organizationId)).filter((job) => job.dedupeKey?.startsWith("email:payment-received-"))

  /** Puts a delivery back as the outbox leaves it when the worker stopped before the provider call. */
  async function rewindToUnsent(organizationId: string) {
    const jobs = await queuedPaymentEmails(organizationId)
    for (const job of jobs) {
      const { providerMessageId: _sent, ...payload } = job.payload as Record<string, unknown>
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "pending", attempts: 0, result: Prisma.DbNull, runAfter: new Date(), payload: { ...payload, requests: 0 } },
      })
    }
    vi.mocked(deliver).mockClear()
    return jobs
  }

  /**
   * Runs the due jobs; `action` commits right after the worker's final (second) eligibility read,
   * the last check before it records the request and contacts the provider.
   */
  async function dispatchWhile(organizationId: string, paymentId: string, action: () => Promise<unknown>) {
    const delegate = prisma.payment as unknown as { findUnique: (args: { where: { id?: string } }) => Promise<unknown> }
    const original = delegate.findUnique.bind(delegate)
    let reads = 0
    delegate.findUnique = async (args) => {
      const found = await original(args)
      if (args.where.id === paymentId && ++reads === 2) await action()
      return found
    }
    try {
      await runDueJobs({ organizationIds: [organizationId] })
    } finally {
      delegate.findUnique = original
    }
    return reads >= 2
  }

  async function sentMessages(organizationId: string) {
    await runDueJobs({ organizationIds: [organizationId] })
    const messages = vi.mocked(deliver).mock.calls.map(([message]) => message)
    vi.mocked(deliver).mockClear()
    return messages
  }

  /** Records a bank receipt and allocates it to the invoice; returns the allocation's payment id. */
  async function allocateBankReceipt(org: Awaited<ReturnType<typeof setup>>["org"], invoiceId: string, amount: string) {
    const actor = org.actors.admin
    const contactId = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).contactId
    const evidence = { reason: "Bank statement reconciled", evidence: "https://evidence.example.test/statement/1" }
    const receiptInput = { requestId: crypto.randomUUID(), contactId, currency: "USD", netAmount: amount, feeAmount: "0", reference: crypto.randomUUID(), method: "bank_transfer" as const, paidAt: "2026-06-01", ...evidence }
    const receipt = await executeCommand(recordReceipt, receiptInput, { actor, clientRequestId: receiptInput.requestId })
    if (receipt.status !== "completed") throw new Error("receipt setup failed")
    const input: ReceiptAllocateInput = { requestId: crypto.randomUUID(), receiptId: receipt.result.receiptId, allocations: [{ invoiceId, receiptAmount: amount, invoiceAmount: amount }], ...evidence }
    const { previewToken } = await prisma.$transaction((db) => previewReceiptAllocation(db, actor.organizationId, input))
    const allocated = await executeCommand(allocateReceipt, { ...input, previewToken }, { actor })
    if (allocated.status !== "completed") throw new Error(`allocation failed: ${JSON.stringify(allocated)}`)
    return { paymentId: allocated.result.paymentIds[0]!, evidence }
  }

  async function reverseAllocation(org: Awaited<ReturnType<typeof setup>>["org"], paymentId: string, evidence: { reason: string; evidence: string }) {
    const parsed = receiptActionInputSchema.parse({ requestId: crypto.randomUUID(), action: "reverse_allocation", paymentId, ...evidence })
    const { previewToken } = await prisma.$transaction((db) => previewReceiptChange(db, org.organizationId, parsed))
    return executeCommand(changeReceipt, { ...parsed, previewToken }, { actor: org.actors.admin })
  }

  it("emails the customer and the seller once when a Stripe payment pays the invoice", async () => {
    const { org, invoiceId } = await setup({ locale: "en-US" })
    await executeIssuanceCommand(recordStripeCheckoutPayment, stripePayment(invoiceId, "cs_1", 250), { actor: webhook(org.organizationId) })

    const messages = await sentMessages(org.organizationId)
    expect(messages.map((message) => message.to).sort()).toEqual(["customer@kunde.test", "seller@acme.test"])
    const client = messages.find((message) => message.to === "customer@kunde.test")!
    const seller = messages.find((message) => message.to === "seller@acme.test")!
    expect(client.subject).toMatch(/^Payment received for invoice /)
    expect(client.html).toContain("Acme ApS has received your payment")
    expect(client.html).toContain("$250.00")
    expect(client.html).toContain("June 2, 2026")
    expect(seller.subject).toMatch(/^Kunde & Co paid invoice /)
  })

  it("sends nothing more when the webhook is delivered again", async () => {
    const { org, invoiceId } = await setup()
    const input = stripePayment(invoiceId, "cs_retry", 250)
    await executeIssuanceCommand(recordStripeCheckoutPayment, input, { actor: webhook(org.organizationId) })
    await executeIssuanceCommand(recordStripeCheckoutPayment, input, { actor: webhook(org.organizationId) })

    expect(await queuedPaymentEmails(org.organizationId)).toHaveLength(2)
    expect(await sentMessages(org.organizationId)).toHaveLength(2)
    await executeIssuanceCommand(recordStripeCheckoutPayment, input, { actor: webhook(org.organizationId) })
    expect(await sentMessages(org.organizationId)).toHaveLength(0)
  })

  it("writes both emails in the Danish document locale", async () => {
    const { org, invoiceId } = await setup({ locale: "da-DK", currency: "DKK" })
    await executeIssuanceCommand(recordStripeCheckoutPayment, stripePayment(invoiceId, "cs_da", 250, "dkk"), { actor: webhook(org.organizationId) })

    const messages = await sentMessages(org.organizationId)
    expect(messages).toHaveLength(2)
    const client = messages.find((message) => message.to === "customer@kunde.test")!
    expect(client.subject).toMatch(/^Betaling modtaget for faktura /)
    expect(client.html).toContain("2. juni 2026")
    expect(messages.find((message) => message.to === "seller@acme.test")!.subject).toMatch(/^Kunde & Co har betalt faktura /)
  })

  it("waits for the invoice to be paid in full", async () => {
    const { org, invoiceId } = await setup()
    await executeIssuanceCommand(recordStripeCheckoutPayment, stripePayment(invoiceId, "cs_part", 100), { actor: webhook(org.organizationId) })
    expect(await queuedPaymentEmails(org.organizationId)).toHaveLength(0)

    await executeIssuanceCommand(recordStripeCheckoutPayment, stripePayment(invoiceId, "cs_rest", 150), { actor: webhook(org.organizationId) })
    const messages = await sentMessages(org.organizationId)
    expect(messages).toHaveLength(2)
    expect(messages.find((message) => message.to === "customer@kunde.test")!.html).toContain("$150.00")
  })

  it("tells only the seller about a payment recorded by hand", async () => {
    const { org, invoiceId } = await setup()
    await executeIssuanceCommand(recordPayment, { invoiceId, amount: 250, paidAt: "2026-06-02", method: "bank_transfer" }, { actor: org.actors.admin })
    const messages = await sentMessages(org.organizationId)
    expect(messages.map((message) => message.to)).toEqual(["seller@acme.test"])
  })

  /** The undo window of a mark-paid closes: its held notice becomes due. */
  const closeUndoWindow = (organizationId: string) =>
    prisma.job.updateMany({ where: { organizationId, type: "email.deliver", status: "pending" }, data: { runAfter: new Date(0) } })

  it.each([false, true])("payment-match email survives reload and respects Fortryd=%s", async undo => {
    const { org, invoiceId } = await setup()
    const caller = () => paymentsRouter.createCaller({ session: {
      user: { id: org.actors.admin.userId }, session: { activeOrganizationId: org.organizationId },
    } } as never)
    const input = { invoiceId, amount: 250, paidAt: "2026-06-02", method: "bank_transfer" as const, requestId: crypto.randomUUID() }
    const started = Date.now()
    const recorded = await caller().record(input)
    const [job] = await queuedPaymentEmails(org.organizationId)
    expect(job!.runAfter.getTime()).toBeGreaterThanOrEqual(started + UNDO_WINDOW_MS)
    expect(await sentMessages(org.organizationId)).toEqual([])

    // Fresh callers have no card state or timers; a retry must retain the same payment and hold.
    expect((await caller().record(input)).payment.id).toBe(recorded.payment.id)
    expect(await queuedPaymentEmails(org.organizationId)).toHaveLength(1)
    expect(await sentMessages(org.organizationId)).toEqual([])
    if (undo) await caller().void({ paymentId: recorded.payment.id, reason: "Fortryd" })
    await closeUndoWindow(org.organizationId)
    expect((await sentMessages(org.organizationId)).map(message => message.to)).toEqual(undo ? [] : ["seller@acme.test"])
    if (undo) expect((await prisma.job.findUniqueOrThrow({ where: { id: job!.id } })).result).toMatchObject({ outcome: "withdrawn" })
  })

  it("tells only the seller about an invoice marked paid, once the undo window has closed", async () => {
    const { org, invoiceId } = await setup()
    await executeIssuanceCommand(markInvoicePaid, { invoiceId, requestId: crypto.randomUUID() }, { actor: org.actors.admin })
    expect(await sentMessages(org.organizationId)).toEqual([])
    await closeUndoWindow(org.organizationId)
    const messages = await sentMessages(org.organizationId)
    expect(messages.map((message) => message.to)).toEqual(["seller@acme.test"])
  })

  it("sends no notice at all when Fortryd undoes the mark-paid inside the window", async () => {
    const { org, invoiceId } = await setup()
    const marked = await executeIssuanceCommand(markInvoicePaid, { invoiceId, requestId: crypto.randomUUID() }, { actor: org.actors.admin })
    if (marked.status !== "completed") throw new Error("mark paid failed")
    const undone = await executeIssuanceCommand(undoInvoiceMarkPaid, { invoiceId, paymentId: marked.result.paymentId, requestId: crypto.randomUUID() }, { actor: org.actors.admin })
    expect(undone.status).toBe("completed")
    await closeUndoWindow(org.organizationId)
    expect(await sentMessages(org.organizationId)).toEqual([])
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).paymentStatus).not.toBe("paid")
  })

  it("skips a customer without a valid address and still tells the seller", async () => {
    const { org, invoiceId } = await setup()
    await prisma.contact.updateMany({ where: { organizationId: org.organizationId }, data: { email: "not-an-address" } })
    await executeIssuanceCommand(recordStripeCheckoutPayment, stripePayment(invoiceId, "cs_noemail", 250), { actor: webhook(org.organizationId) })
    expect((await sentMessages(org.organizationId)).map((message) => message.to)).toEqual(["seller@acme.test"])
  })

  it("queues nothing where this installation cannot send email", async () => {
    delete process.env.RESEND_API_KEY
    const { org, invoiceId } = await setup()
    const outcome = await executeIssuanceCommand(recordStripeCheckoutPayment, stripePayment(invoiceId, "cs_nomail", 250), { actor: webhook(org.organizationId) })
    expect(outcome.status).toBe("completed")
    expect(await queuedPaymentEmails(org.organizationId)).toHaveLength(0)
  })

  it("does not confirm to the customer a payment that merely claims to be Stripe", async () => {
    const { org, invoiceId } = await setup()
    await executeIssuanceCommand(recordPayment, { invoiceId, amount: 250, paidAt: "2026-06-01", method: "stripe" }, { actor: org.actors.admin })
    expect((await sentMessages(org.organizationId)).map((message) => message.to)).toEqual(["seller@acme.test"])
  })

  it("withdraws unsent emails when the payment is voided", async () => {
    const { org, invoiceId } = await setup()
    const recorded = await executeIssuanceCommand(recordPayment, { invoiceId, amount: 250, paidAt: "2026-06-01", method: "bank_transfer" }, { actor: org.actors.admin })
    if (recorded.status !== "completed") throw new Error("record failed")
    await rewindToUnsent(org.organizationId)
    await executeIssuanceCommand(voidPayment, { paymentId: recorded.result.payment.id, reason: "Entered twice" }, { actor: org.actors.admin })
    expect(await sentMessages(org.organizationId)).toEqual([])
  })

  it("does not send when an undo commits between the eligibility check and the provider request", async () => {
    const { org, invoiceId } = await setup()
    const marked = await executeIssuanceCommand(markInvoicePaid, { invoiceId, requestId: crypto.randomUUID() }, { actor: org.actors.admin })
    if (marked.status !== "completed") throw new Error("mark paid failed")
    const jobs = await rewindToUnsent(org.organizationId)

    // Commit the undo right after the worker's final eligibility read.
    let undone: Awaited<ReturnType<typeof executeIssuanceCommand>> | undefined
    const acted = await dispatchWhile(org.organizationId, marked.result.paymentId, async () => {
      undone = await executeIssuanceCommand(
        undoInvoiceMarkPaid,
        { invoiceId, paymentId: marked.result.paymentId, requestId: crypto.randomUUID() },
        { actor: org.actors.admin }
      )
    })

    expect(acted).toBe(true)
    expect(undone?.status).toBe("completed")
    expect(deliver).not.toHaveBeenCalled()
    expect((await prisma.job.findUniqueOrThrow({ where: { id: jobs[0]!.id } })).result).toMatchObject({ outcome: "withdrawn" })
  })

  it("does not send when voiding an earlier payment reopens the invoice during dispatch", async () => {
    const { org, invoiceId } = await setup()
    const record = async (amount: number) => {
      const recorded = await executeIssuanceCommand(recordPayment, { invoiceId, amount, paidAt: "2026-06-01", method: "bank_transfer" }, { actor: org.actors.admin })
      if (recorded.status !== "completed") throw new Error("record failed")
      return recorded.result.payment.id
    }
    const partial = await record(100)
    const final = await record(150)
    const jobs = await rewindToUnsent(org.organizationId)
    expect(jobs).toHaveLength(1)

    // The earlier partial payment is voided right after the worker's final eligibility read.
    let voided: Awaited<ReturnType<typeof executeIssuanceCommand>> | undefined
    const acted = await dispatchWhile(org.organizationId, final, async () => {
      voided = await executeIssuanceCommand(voidPayment, { paymentId: partial, reason: "Entered twice" }, { actor: org.actors.admin })
    })

    expect(acted).toBe(true)
    expect(voided?.status).toBe("completed")
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).paymentStatus).toBe("partially_paid")
    expect(deliver).not.toHaveBeenCalled()
    expect((await prisma.job.findUniqueOrThrow({ where: { id: jobs[0]!.id } })).result).toMatchObject({ outcome: "withdrawn" })
  })

  it("tells only the seller when a receipt allocation settles the invoice", async () => {
    const { org, invoiceId } = await setup()
    await allocateBankReceipt(org, invoiceId, "250")
    expect((await sentMessages(org.organizationId)).map((message) => message.to)).toEqual(["seller@acme.test"])
  })

  it("waits for the last receipt allocation before telling the seller", async () => {
    const { org, invoiceId } = await setup()
    await allocateBankReceipt(org, invoiceId, "100")
    expect(await queuedPaymentEmails(org.organizationId)).toHaveLength(0)
  })

  it("withdraws unsent emails when a receipt allocation is reversed", async () => {
    const { org, invoiceId } = await setup()
    const { paymentId, evidence } = await allocateBankReceipt(org, invoiceId, "250")
    await rewindToUnsent(org.organizationId)
    expect((await reverseAllocation(org, paymentId, evidence)).status).toBe("completed")
    expect(await sentMessages(org.organizationId)).toEqual([])
  })

  it("does not send when a receipt allocation is reversed during dispatch and reopens the invoice", async () => {
    const { org, invoiceId } = await setup()
    const earlier = await allocateBankReceipt(org, invoiceId, "100")
    const final = await executeIssuanceCommand(recordPayment, { invoiceId, amount: 150, paidAt: "2026-06-01", method: "bank_transfer" }, { actor: org.actors.admin })
    if (final.status !== "completed") throw new Error("record failed")
    const jobs = await rewindToUnsent(org.organizationId)
    expect(jobs).toHaveLength(1)

    // The earlier allocation is reversed right after the worker's final eligibility read.
    let reversed: Awaited<ReturnType<typeof reverseAllocation>> | undefined
    const acted = await dispatchWhile(org.organizationId, final.result.payment.id, async () => {
      reversed = await reverseAllocation(org, earlier.paymentId, earlier.evidence)
    })

    expect(acted).toBe(true)
    expect(reversed?.status).toBe("completed")
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).paymentStatus).toBe("partially_paid")
    expect(deliver).not.toHaveBeenCalled()
    expect((await prisma.job.findUniqueOrThrow({ where: { id: jobs[0]!.id } })).result).toMatchObject({ outcome: "withdrawn" })
  })
})
