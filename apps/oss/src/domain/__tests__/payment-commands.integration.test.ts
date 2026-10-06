import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import { processStripeWebhookEvent } from "../../lib/payments/webhooks"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createAgentKey, authenticateAgentSecret } from "../agent-keys"
import { decideApproval } from "../approvals"
import { createContact } from "../commands/contacts"
import { createInvoiceDraft, sendInvoice } from "../commands/invoices"
import { recordPayment, recordStripeCheckoutPayment, voidPayment } from "../commands/payments"
import { readActivity } from "../events"
import { executeCommand } from "../execute"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

describeIfDatabase("payment commands", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  /** Creates an organization with one sent invoice totalling 250.00 (200 + 25% tax). */
  async function setupSentInvoice(options: { currency?: string; dueDate?: string } = {}) {
    const org = await createTestOrganization({ roles: ["admin", "member"] })
    cleanups.push(org.cleanup)
    const contact = await executeCommand(
      createContact,
      { name: "Acme", email: "billing@acme.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const draft = await executeCommand(
      createInvoiceDraft,
      {
        contactId: contact.result.id,
        dueDate: options.dueDate ?? "2099-12-01",
        currency: options.currency,
        taxRate: 25,
        items: [{ description: "Design", quantity: 2, unitPrice: 100 }],
      },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error(`draft failed: ${JSON.stringify(draft)}`)
    const sent = await executeCommand(
      sendInvoice,
      { id: draft.result.id, allowSendWithoutEmail: true },
      { actor: org.actors.admin }
    )
    if (sent.status !== "completed") throw new Error(`send failed: ${JSON.stringify(sent)}`)
    return { org, invoiceId: draft.result.id }
  }

  const loadInvoice = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id } })

  function payment(invoiceId: string, amount: number, extra: Record<string, unknown> = {}) {
    return { invoiceId, amount, paidAt: "2026-01-15", method: "bank_transfer", ...extra }
  }

  it("records partial and final payments and settles the invoice", async () => {
    const { org, invoiceId } = await setupSentInvoice()

    const partial = await executeCommand(recordPayment, payment(invoiceId, 100, { reference: "TX-1" }), {
      actor: org.actors.member,
    })
    expect(partial.status).toBe("completed")
    if (partial.status !== "completed") return
    expect(partial.result.balanceDue.toNumber()).toBe(150)
    expect(partial.result.payment).toMatchObject({ currency: "USD", method: "bank_transfer", source: "user" })

    const afterPartial = await loadInvoice(invoiceId)
    expect(afterPartial).toMatchObject({ status: "sent", paymentStatus: "partially_paid", paidAt: null })
    expect(afterPartial.amountPaid.toNumber()).toBe(100)

    const final = await executeCommand(recordPayment, payment(invoiceId, 150, { paidAt: "2026-01-20" }), {
      actor: org.actors.member,
    })
    expect(final.status).toBe("completed")

    const paid = await loadInvoice(invoiceId)
    expect(paid).toMatchObject({ status: "paid", paymentStatus: "paid" })
    expect(paid.amountPaid.toNumber()).toBe(250)
    expect(paid.paidAt?.toISOString()).toBe("2026-01-20T00:00:00.000Z")

    const activity = await readActivity({
      organizationId: org.organizationId,
      aggregateType: "invoice",
      aggregateId: invoiceId,
    })
    expect(activity.events.map((event) => event.type)).toEqual([
      "invoice.draft_created",
      "invoice.sent",
      "payment.recorded",
      "payment.recorded",
      "invoice.paid",
    ])
  })

  it("rejects overpayments, future dates, drafts, and paid invoices", async () => {
    const { org, invoiceId } = await setupSentInvoice()
    const actor = org.actors.admin

    const over = await executeCommand(recordPayment, payment(invoiceId, 250.01), { actor })
    expect(over).toMatchObject({ status: "failed", error: { tag: "InvalidState", code: "overpayment" } })
    if (over.status === "failed") {
      expect(over.error.message).toContain("exceeds the balance due of 250.00 USD")
    }

    const future = await executeCommand(
      recordPayment,
      payment(invoiceId, 10, { paidAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }),
      { actor }
    )
    expect(future).toMatchObject({ status: "failed", error: { tag: "ValidationFailed" } })

    const invalid = await executeCommand(recordPayment, payment(invoiceId, -1), { actor })
    expect(invalid).toMatchObject({ status: "failed", error: { tag: "ValidationFailed" } })

    await executeCommand(recordPayment, payment(invoiceId, 250), { actor })
    const again = await executeCommand(recordPayment, payment(invoiceId, 1), { actor })
    expect(again).toMatchObject({ status: "failed", error: { code: "invoice_already_paid" } })

    const contact = await prisma.contact.findFirstOrThrow({ where: { organizationId: org.organizationId } })
    const draft = await executeCommand(
      createInvoiceDraft,
      { contactId: contact.id, dueDate: "2099-12-01", items: [{ description: "X", quantity: 1, unitPrice: 10 }] },
      { actor }
    )
    if (draft.status !== "completed") throw new Error("draft failed")
    const onDraft = await executeCommand(recordPayment, payment(draft.result.id, 5), { actor })
    expect(onDraft).toMatchObject({ status: "failed", error: { code: "invoice_not_issued" } })

    const missing = await executeCommand(recordPayment, payment("missing-invoice", 5), { actor })
    expect(missing).toMatchObject({ status: "failed", error: { tag: "NotFound" } })
  })

  it("serializes concurrent payments so the balance can never be exceeded", async () => {
    const { org, invoiceId } = await setupSentInvoice()
    const outcomes = await Promise.all(
      [1, 2, 3].map(() => executeCommand(recordPayment, payment(invoiceId, 100), { actor: org.actors.admin }))
    )
    expect(outcomes.filter((outcome) => outcome.status === "completed")).toHaveLength(2)
    expect((await loadInvoice(invoiceId)).amountPaid.toNumber()).toBe(200)
  })

  it("voids a payment, reopening a paid invoice, and only admins may void", async () => {
    const { org, invoiceId } = await setupSentInvoice({ dueDate: "2020-01-01" })
    const recorded = await executeCommand(recordPayment, payment(invoiceId, 250), { actor: org.actors.admin })
    if (recorded.status !== "completed") throw new Error("record failed")
    expect((await loadInvoice(invoiceId)).status).toBe("paid")

    const byMember = await executeCommand(
      voidPayment,
      { paymentId: recorded.result.payment.id, reason: "Bounced" },
      { actor: org.actors.member }
    )
    expect(byMember).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })

    const noReason = await executeCommand(
      voidPayment,
      { paymentId: recorded.result.payment.id, reason: " " },
      { actor: org.actors.admin }
    )
    expect(noReason).toMatchObject({ status: "failed", error: { tag: "ValidationFailed" } })

    const voided = await executeCommand(
      voidPayment,
      { paymentId: recorded.result.payment.id, reason: "Bounced" },
      { actor: org.actors.admin }
    )
    expect(voided.status).toBe("completed")
    if (voided.status !== "completed") return
    expect(voided.result.payment.voidReason).toBe("Bounced")
    expect(voided.result.payment.voidedAt).toBeInstanceOf(Date)

    const reopened = await loadInvoice(invoiceId)
    expect(reopened).toMatchObject({ status: "overdue", paymentStatus: "unpaid", paidAt: null })
    expect(reopened.amountPaid.toNumber()).toBe(0)

    const twice = await executeCommand(
      voidPayment,
      { paymentId: recorded.result.payment.id, reason: "Again" },
      { actor: org.actors.admin }
    )
    expect(twice).toMatchObject({ status: "failed", error: { code: "payment_already_voided" } })

    const activity = await readActivity({
      organizationId: org.organizationId,
      aggregateType: "invoice",
      aggregateId: invoiceId,
    })
    expect(activity.events.at(-1)).toMatchObject({ type: "payment.voided", payload: { reason: "Bounced" } })
  })

  it("queues agent payments for approval and records them once approved", async () => {
    const { org, invoiceId } = await setupSentInvoice()
    const { secret } = await createAgentKey(org.actors.admin, {
      name: "Bookkeeper",
      mode: "approval_required",
      scopes: ["payment:create", "payment:read", "payment:void"],
    })
    const agent = await authenticateAgentSecret(secret)
    if (!agent) throw new Error("agent auth failed")

    const queued = await executeCommand(recordPayment, payment(invoiceId, 50), {
      actor: agent,
      clientRequestId: "agent-pay-1",
    })
    expect(queued.status).toBe("awaiting_approval")
    expect(await prisma.payment.count({ where: { invoiceId } })).toBe(0)
    if (queued.status !== "awaiting_approval") return

    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: queued.approvalRequestId } })
    expect(approval.summary).toContain("50.00 bank transfer payment")

    const decided = await decideApproval({
      approvalRequestId: queued.approvalRequestId,
      decider: org.actors.admin,
      decision: "approve",
    })
    expect(decided.status).toBe("completed")

    const recorded = await prisma.payment.findFirstOrThrow({ where: { invoiceId } })
    expect(recorded).toMatchObject({ source: "agent", method: "bank_transfer" })
    expect(recorded.amount.toNumber()).toBe(50)
  })

  it("only lets the Stripe webhook record Stripe checkout payments", async () => {
    const { org, invoiceId } = await setupSentInvoice()
    const outcome = await executeCommand(
      recordStripeCheckoutPayment,
      {
        invoiceId,
        checkoutSessionId: "cs_forged",
        paymentIntentId: null,
        currency: "usd",
        paidAt: new Date().toISOString(),
      },
      { actor: org.actors.admin }
    )
    expect(outcome).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
  })

  describe("stripe webhooks", () => {
    function checkoutEvent(input: {
      invoiceId: string
      sessionId: string
      amountTotal?: number
      currency?: string
    }) {
      return {
        type: "checkout.session.completed",
        created: 1_772_761_600,
        data: {
          object: {
            id: input.sessionId,
            payment_intent: `pi_${input.sessionId}`,
            client_reference_id: input.invoiceId,
            amount_total: input.amountTotal,
            currency: input.currency,
            metadata: { invoiceId: input.invoiceId },
          },
        },
      }
    }

    it("records the charged amount once per checkout session", async () => {
      const { org, invoiceId } = await setupSentInvoice()
      const sessionId = `cs_${invoiceId}`
      const event = checkoutEvent({ invoiceId, sessionId, amountTotal: 10_000, currency: "usd" })

      const results = await Promise.all([
        processStripeWebhookEvent(event, { organizationId: org.organizationId }),
        processStripeWebhookEvent(event, { organizationId: org.organizationId }),
      ])
      expect(results.every((result) => result.handled)).toBe(true)
      const again = await processStripeWebhookEvent(event, { organizationId: org.organizationId })
      expect(again).toEqual({ handled: true, alreadyApplied: true })

      const payments = await prisma.payment.findMany({ where: { invoiceId } })
      expect(payments).toHaveLength(1)
      expect(payments[0]).toMatchObject({
        method: "stripe",
        source: "stripe",
        stripeCheckoutSessionId: sessionId,
        stripePaymentIntentId: `pi_${sessionId}`,
      })
      expect(payments[0]?.amount.toNumber()).toBe(100)

      const invoice = await loadInvoice(invoiceId)
      expect(invoice).toMatchObject({ paymentStatus: "partially_paid", status: "sent" })
      expect(invoice.amountPaid.toNumber()).toBe(100)
    })

    it("converts zero-decimal currencies and ignores invoices of other organizations", async () => {
      const { org, invoiceId } = await setupSentInvoice({ currency: "JPY" })
      const other = await createTestOrganization()
      cleanups.push(other.cleanup)

      const foreign = await processStripeWebhookEvent(
        checkoutEvent({ invoiceId, sessionId: `cs_foreign_${invoiceId}`, amountTotal: 250, currency: "jpy" }),
        { organizationId: other.organizationId }
      )
      expect(foreign.handled).toBe(false)

      const applied = await processStripeWebhookEvent(
        checkoutEvent({ invoiceId, sessionId: `cs_jpy_${invoiceId}`, amountTotal: 250, currency: "jpy" }),
        { organizationId: org.organizationId }
      )
      expect(applied).toEqual({ handled: true, alreadyApplied: false })

      const invoice = await loadInvoice(invoiceId)
      expect(invoice.amountPaid.toNumber()).toBe(250)
      expect(invoice.paymentStatus).toBe("paid")
    })
  })
})
