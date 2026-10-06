import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../lib/db"
import { formatIsoDate } from "../../lib/exports/format"
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
  async function setupSentInvoice(
    options: { currency?: string; dueDate?: string; timezone?: string; unitPrice?: number } = {}
  ) {
    const org = await createTestOrganization({
      roles: ["admin", "member"],
      settings: options.timezone ? { timezone: options.timezone } : undefined,
    })
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
        items: [{ description: "Design", quantity: 2, unitPrice: options.unitPrice ?? 100 }],
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
        amount: 100,
        currency: "usd",
        paidAt: new Date().toISOString(),
      },
      { actor: org.actors.admin }
    )
    expect(outcome).toMatchObject({ status: "failed", error: { tag: "Forbidden" } })
  })

  it("rejects amounts with more decimals than the invoice currency allows", async () => {
    const { org, invoiceId } = await setupSentInvoice({ currency: "JPY" })
    const actor = org.actors.admin

    const fractional = await executeCommand(recordPayment, payment(invoiceId, 100.5), { actor })
    expect(fractional).toMatchObject({ status: "failed", error: { tag: "ValidationFailed" } })
    if (fractional.status === "failed") {
      expect(fractional.error.message).toContain("JPY")
    }

    const whole = await executeCommand(recordPayment, payment(invoiceId, 100), { actor })
    expect(whole.status).toBe("completed")
  })

  it("settles an exact fractional balance even when the currency has no minor unit", async () => {
    const { org, invoiceId } = await setupSentInvoice({ currency: "JPY", unitPrice: 50.2 })
    const balance = (await loadInvoice(invoiceId)).totalGross.toNumber()
    expect(balance).toBe(125.5)

    const exact = await executeCommand(recordPayment, payment(invoiceId, balance), { actor: org.actors.admin })
    expect(exact.status).toBe("completed")
  })

  it("stores a calendar payment date as that day in the organization's time zone", async () => {
    const timeZone = "America/New_York"
    const { org, invoiceId } = await setupSentInvoice({ timezone: timeZone })

    const recorded = await executeCommand(
      recordPayment,
      payment(invoiceId, 100, { paidAt: "2026-10-01" }),
      { actor: org.actors.admin }
    )
    expect(recorded.status).toBe("completed")
    if (recorded.status !== "completed") return
    expect(recorded.result.payment.paidAt.toISOString()).toBe("2026-10-01T04:00:00.000Z")
    expect(formatIsoDate(recorded.result.payment.paidAt, timeZone)).toBe("2026-10-01")

    const winter = await executeCommand(
      recordPayment,
      payment(invoiceId, 50, { paidAt: "2026-01-15" }),
      { actor: org.actors.admin }
    )
    if (winter.status !== "completed") throw new Error("winter payment failed")
    expect(winter.result.payment.paidAt.toISOString()).toBe("2026-01-15T05:00:00.000Z")

    const stamped = await executeCommand(
      recordPayment,
      payment(invoiceId, 10, { paidAt: "2026-03-02T18:30:00.000Z" }),
      { actor: org.actors.admin }
    )
    if (stamped.status !== "completed") throw new Error("timestamped payment failed")
    expect(stamped.result.payment.paidAt.toISOString()).toBe("2026-03-02T18:30:00.000Z")
  })

  it("rejects a calendar date after today in the organization's time zone", async () => {
    const { org, invoiceId } = await setupSentInvoice({ timezone: "Pacific/Kiritimati" })
    const tomorrow = new Date(Date.now() + 2 * 86_400_000)
    const future = formatIsoDate(tomorrow, "Pacific/Kiritimati")
    const outcome = await executeCommand(recordPayment, payment(invoiceId, 10, { paidAt: future }), {
      actor: org.actors.admin,
    })
    expect(outcome).toMatchObject({ status: "failed", error: { tag: "ValidationFailed" } })

    const today = formatIsoDate(new Date(), "Pacific/Kiritimati")
    const ok = await executeCommand(recordPayment, payment(invoiceId, 10, { paidAt: today }), {
      actor: org.actors.admin,
    })
    expect(ok.status).toBe("completed")
  })

  describe("stripe webhooks", () => {
    function checkoutEvent(input: {
      invoiceId: string
      sessionId: string
      amountTotal?: number | null
      currency?: string | null
      paymentStatus?: string
      type?: string
    }) {
      return {
        type: input.type ?? "checkout.session.completed",
        created: 1_772_761_600,
        data: {
          object: {
            id: input.sessionId,
            payment_intent: `pi_${input.sessionId}`,
            client_reference_id: input.invoiceId,
            amount_total: input.amountTotal,
            currency: input.currency,
            payment_status: input.paymentStatus ?? "paid",
            metadata: { invoiceId: input.invoiceId },
          },
        },
      }
    }

    it("waits for asynchronous payment methods to succeed before recording money", async () => {
      const { org, invoiceId } = await setupSentInvoice()
      const sessionId = `cs_async_${invoiceId}`
      const options = { organizationId: org.organizationId }

      const pending = await processStripeWebhookEvent(
        checkoutEvent({ invoiceId, sessionId, amountTotal: 25_000, currency: "usd", paymentStatus: "unpaid" }),
        options
      )
      expect(pending.handled).toBe(false)
      expect(await prisma.payment.count({ where: { invoiceId } })).toBe(0)

      const succeeded = await processStripeWebhookEvent(
        checkoutEvent({
          invoiceId,
          sessionId,
          amountTotal: 25_000,
          currency: "usd",
          type: "checkout.session.async_payment_succeeded",
        }),
        options
      )
      expect(succeeded).toEqual({ handled: true, alreadyApplied: false })
      const invoice = await loadInvoice(invoiceId)
      expect(invoice).toMatchObject({ paymentStatus: "paid", paymentFailureReason: null })
      expect(invoice.amountPaid.toNumber()).toBe(250)
    })

    it("records an asynchronous payment failure on the invoice without recording money", async () => {
      const { org, invoiceId } = await setupSentInvoice()
      const sessionId = `cs_async_failed_${invoiceId}`

      const failed = await processStripeWebhookEvent(
        checkoutEvent({
          invoiceId,
          sessionId,
          amountTotal: 25_000,
          currency: "usd",
          paymentStatus: "unpaid",
          type: "checkout.session.async_payment_failed",
        }),
        { organizationId: org.organizationId }
      )
      expect(failed).toEqual({ handled: true, alreadyApplied: false })
      expect(await prisma.payment.count({ where: { invoiceId } })).toBe(0)
      const invoice = await loadInvoice(invoiceId)
      expect(invoice.paymentStatus).toBe("unpaid")
      expect(invoice.paymentFailureReason).toContain(sessionId)
      expect(invoice.stripeCheckoutSessionId).toBe(sessionId)

      const activity = await readActivity({
        organizationId: org.organizationId,
        aggregateType: "invoice",
        aggregateId: invoiceId,
      })
      expect(activity.events.at(-1)).toMatchObject({ type: "payment.failed" })
    })

    it("never substitutes the balance for a missing or zero amount, or records another currency", async () => {
      const { org, invoiceId } = await setupSentInvoice()
      const options = { organizationId: org.organizationId }
      const cases = [
        checkoutEvent({ invoiceId, sessionId: `cs_missing_${invoiceId}`, amountTotal: null, currency: "usd" }),
        checkoutEvent({ invoiceId, sessionId: `cs_zero_${invoiceId}`, amountTotal: 0, currency: "usd" }),
        checkoutEvent({ invoiceId, sessionId: `cs_nocur_${invoiceId}`, amountTotal: 10_000, currency: null }),
        checkoutEvent({ invoiceId, sessionId: `cs_eur_${invoiceId}`, amountTotal: 10_000, currency: "eur" }),
        checkoutEvent({
          invoiceId,
          sessionId: `cs_free_${invoiceId}`,
          amountTotal: 10_000,
          currency: "usd",
          paymentStatus: "no_payment_required",
        }),
      ]
      for (const event of cases) {
        const result = await processStripeWebhookEvent(event, options)
        expect(result.handled).toBe(false)
      }
      expect(await prisma.payment.count({ where: { invoiceId } })).toBe(0)
      expect((await loadInvoice(invoiceId)).paymentStatus).toBe("unpaid")
    })

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
