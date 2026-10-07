import { executeIssuanceCommand } from "../../application/issuance"
import "dotenv/config"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContact } from "../../domain/commands/contacts"
import { issueCreditNote } from "../../domain/commands/credit-notes"
import { createInvoiceDraft, sendInvoice } from "../../domain/commands/invoices"
import { recordPayment, voidPayment } from "../../domain/commands/payments"
import { EXPIRE_CHECKOUT_SESSION_JOB } from "../../domain/documents/checkout-sessions"
import { readActivity } from "../../domain/events"
import { runDueJobs } from "../../domain/jobs"

import { processStripeWebhookEvent } from "../payments/webhooks"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { prisma } from "../db"
import { signInvoicePaymentToken } from "../payments/public"
import { loadPublicInvoiceByToken } from "../payments/public-access"
import { resolvePublicInvoiceCheckout } from "../payments/public-checkout"
import { serializePublicInvoiceSession } from "../payments/public-session"
import { encryptSecret } from "../secrets"

const createCheckoutSession = vi.hoisted(() => vi.fn())
const expireCheckoutSession = vi.hoisted(() => vi.fn())

vi.mock("../payments/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../payments/stripe")>()),
  createStripeInvoiceCheckoutSession: createCheckoutSession,
  expireOpenStripeCheckoutSession: expireCheckoutSession,
}))

const describeIfDatabase = hasTestDatabase ? describe : describe.skip
const paymentSecret = "payment-link-secret-settlement-123456"

describeIfDatabase("public invoice links after settlement changes", () => {
  const cleanups: Array<() => Promise<void>> = []
  const previousSecret = process.env.QUITS_PUBLIC_PAYMENT_SECRET

  beforeEach(() => {
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = paymentSecret
    createCheckoutSession.mockReset()
    let sessions = 0
    createCheckoutSession.mockImplementation(async () => {
      sessions += 1
      return { id: `cs_${sessions}_${Date.now()}`, url: `https://checkout.stripe.test/${sessions}` }
    })
    expireCheckoutSession.mockReset()
    expireCheckoutSession.mockResolvedValue("expired")
  })

  afterEach(async () => {
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = previousSecret
    while (cleanups.length) await cleanups.pop()?.()
  })

  /** A sent 100 USD invoice with a public payment link and Stripe configured. */
  async function setup() {
    const org = await createTestOrganization()
    cleanups.push(async () => {
      await prisma.creditNote.deleteMany({ where: { organizationId: org.organizationId } })
      await org.cleanup()
    })
    await prisma.orgSettings.update({
      where: { organizationId: org.organizationId },
      data: {
        stripePublishableKey: "pk_test_123456789",
        stripeSecretKeyEnc: encryptSecret("sk_test_12345678901234567890"),
        stripeWebhookSecretEnc: encryptSecret("whsec_test_12345678901234567890"),
      },
    })
    const contact = await executeIssuanceCommand(
      createContact,
      { name: "Buyer", email: "buyer@example.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const draft = await executeIssuanceCommand(
      createInvoiceDraft,
      {
        contactId: contact.result.id,
        dueDate: "2099-12-01",
        currency: "USD",
        taxRate: 0,
        items: [{ description: "Consulting", quantity: 1, unitPrice: 100 }],
      },
      { actor: org.actors.admin }
    )
    if (draft.status !== "completed") throw new Error(`draft failed: ${JSON.stringify(draft)}`)
    const sent = await executeIssuanceCommand(
      sendInvoice,
      { id: draft.result.id, allowSendWithoutEmail: true },
      { actor: org.actors.admin }
    )
    if (sent.status !== "completed") throw new Error("send failed")
    const invoice = await prisma.invoice.update({
      where: { id: draft.result.id },
      data: { publicPaymentIssuedAt: new Date() },
    })
    const token = signInvoicePaymentToken(
      { invoiceId: invoice.id, keyVersion: invoice.publicPaymentKeyVersion, scope: "invoice_payment" },
      paymentSecret
    )
    return { org, invoiceId: invoice.id, token }
  }

  type Context = Awaited<ReturnType<typeof setup>>

  /** Opens a checkout for the invoice and returns the Stripe session id it created. */
  async function openCheckout(context: Context) {
    const opened = await resolvePublicInvoiceCheckout(context.token)
    expect(opened.status).toBe("redirect")
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: context.invoiceId } })
    if (!invoice.stripeCheckoutSessionId) throw new Error("no checkout session tracked")
    return invoice.stripeCheckoutSessionId
  }

  function bankTransfer(context: Context, amount: number) {
    return executeIssuanceCommand(
      recordPayment,
      { invoiceId: context.invoiceId, amount, paidAt: "2026-01-02", method: "bank_transfer" },
      { actor: context.org.actors.admin }
    )
  }

  const expiredSessions = () => expireCheckoutSession.mock.calls.map(([input]) => (input as { sessionId: string }).sessionId)

  describe("open Stripe Checkout sessions", () => {
    it("expires the open session when a manual payment lowers the balance", async () => {
      const context = await setup()
      const sessionId = await openCheckout(context)
      expect(createCheckoutSession).toHaveBeenLastCalledWith(expect.objectContaining({ amountDue: 100 }))

      const paid = await bankTransfer(context, 50)
      expect(paid.status).toBe("completed")
      expect(expiredSessions()).toEqual([sessionId])
      expect(expireCheckoutSession).toHaveBeenCalledWith({ secretKey: "sk_test_12345678901234567890", sessionId })

      // The next checkout charges what is owed now.
      await openCheckout(context)
      expect(createCheckoutSession).toHaveBeenLastCalledWith(expect.objectContaining({ amountDue: 50 }))
    })

    it("expires the open session when a credit note or a voided payment changes the balance", async () => {
      const context = await setup()
      const paid = await bankTransfer(context, 20)
      if (paid.status !== "completed") throw new Error(JSON.stringify(paid))

      const first = await openCheckout(context)
      const credited = await executeIssuanceCommand(
        issueCreditNote,
        { invoiceId: context.invoiceId, reason: "Discount", mode: "amount", amount: 30 },
        { actor: context.org.actors.admin }
      )
      expect(credited.status).toBe("completed")
      expect(expiredSessions()).toEqual([first])

      const second = await openCheckout(context)
      expect(createCheckoutSession).toHaveBeenLastCalledWith(expect.objectContaining({ amountDue: 50 }))
      const voided = await executeIssuanceCommand(
        voidPayment,
        { paymentId: paid.result.payment.id, reason: "Bounced" },
        { actor: context.org.actors.admin }
      )
      expect(voided.status).toBe("completed")
      expect(expiredSessions()).toContain(second)
    })

    it("still records the payment when Stripe is down, and retries the expiry later", async () => {
      const context = await setup()
      const sessionId = await openCheckout(context)
      expireCheckoutSession.mockRejectedValue(new Error("Stripe is unavailable"))

      const paid = await bankTransfer(context, 50)
      expect(paid.status).toBe("completed")
      const job = await prisma.job.findFirstOrThrow({
        where: { organizationId: context.org.organizationId, type: EXPIRE_CHECKOUT_SESSION_JOB },
      })
      expect(job).toMatchObject({ status: "pending", lastError: "Stripe is unavailable" })
      expect(job.payload).toEqual({ invoiceId: context.invoiceId, checkoutSessionId: sessionId })
    })

    it("expires the session with the API key alone when the rest of the Stripe setup is incomplete", async () => {
      const context = await setup()
      const sessionId = await openCheckout(context)
      await prisma.orgSettings.update({
        where: { organizationId: context.org.organizationId },
        data: { stripeWebhookSecretEnc: null, stripePublishableKey: null },
      })

      const paid = await bankTransfer(context, 50)
      expect(paid.status).toBe("completed")
      expect(expireCheckoutSession).toHaveBeenCalledWith({ secretKey: "sk_test_12345678901234567890", sessionId })
    })

    it("keeps retrying the expiry while the Stripe secret key is missing, and expires once it is back", async () => {
      const context = await setup()
      const sessionId = await openCheckout(context)
      const { stripeSecretKeyEnc } = await prisma.orgSettings.findUniqueOrThrow({
        where: { organizationId: context.org.organizationId },
      })
      await prisma.orgSettings.update({
        where: { organizationId: context.org.organizationId },
        data: { stripeSecretKeyEnc: null },
      })

      const paid = await bankTransfer(context, 50)
      expect(paid.status).toBe("completed")
      expect(expireCheckoutSession).not.toHaveBeenCalled()
      const where = { organizationId: context.org.organizationId, type: EXPIRE_CHECKOUT_SESSION_JOB }
      const failed = await prisma.job.findFirstOrThrow({ where })
      expect(failed.status).toBe("pending")
      expect(failed.lastError).toContain("no Stripe secret key")

      await prisma.orgSettings.update({
        where: { organizationId: context.org.organizationId },
        data: { stripeSecretKeyEnc },
      })
      await runDueJobs({
        now: new Date(Date.now() + 60 * 60 * 1000),
        organizationIds: [context.org.organizationId],
      })
      expect(expireCheckoutSession).toHaveBeenCalledWith({ secretKey: "sk_test_12345678901234567890", sessionId })
      expect((await prisma.job.findFirstOrThrow({ where })).status).toBe("done")
    })

    it("keeps the newer checkout open when an older session's async payment fails", async () => {
      const context = await setup()
      const older = await openCheckout(context)
      const newer = await openCheckout(context)
      expireCheckoutSession.mockClear()

      const failed = await processStripeWebhookEvent(
        {
          type: "checkout.session.async_payment_failed",
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              id: older,
              payment_intent: `pi_${older}`,
              client_reference_id: context.invoiceId,
              amount_total: 10_000,
              currency: "usd",
              payment_status: "unpaid",
              metadata: { invoiceId: context.invoiceId },
            },
          },
        },
        { organizationId: context.org.organizationId }
      )
      expect(failed).toEqual({ handled: true, alreadyApplied: false })
      expect(expireCheckoutSession).not.toHaveBeenCalled()
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: context.invoiceId } })
      expect(invoice).toMatchObject({ stripeCheckoutSessionId: newer, paymentFailureReason: null })
      expect(
        await prisma.job.count({
          where: { organizationId: context.org.organizationId, type: EXPIRE_CHECKOUT_SESSION_JOB },
        })
      ).toBe(0)
      // The failure is still recorded for the activity log.
      const activity = await readActivity({
        organizationId: context.org.organizationId,
        aggregateType: "invoice",
        aggregateId: context.invoiceId,
      })
      expect(activity.events.at(-1)).toMatchObject({
        type: "payment.failed",
        payload: { checkoutSessionId: older, supersededBy: newer },
      })
    })

    it("expires the previous session when the customer opens a new one", async () => {
      const context = await setup()
      const first = await openCheckout(context)
      const second = await openCheckout(context)
      expect(second).not.toBe(first)
      expect(expiredSessions()).toEqual([first])
    })

    it("does not open a checkout while the previous session cannot be expired", async () => {
      const context = await setup()
      await openCheckout(context)
      expireCheckoutSession.mockRejectedValue(new Error("Stripe is unavailable"))
      createCheckoutSession.mockClear()

      expect(await resolvePublicInvoiceCheckout(context.token)).toEqual({ status: "unavailable", url: null })
      expect(createCheckoutSession).not.toHaveBeenCalled()
    })

    it("never hands out a session opened for a balance that changed meanwhile", async () => {
      const context = await setup()
      // A bank transfer is recorded while Stripe creates the session for the old balance.
      createCheckoutSession.mockImplementationOnce(async () => {
        const paid = await bankTransfer(context, 40)
        if (paid.status !== "completed") throw new Error(JSON.stringify(paid))
        return { id: `cs_stale_${context.invoiceId}`, url: "https://checkout.stripe.test/stale" }
      })

      const opened = await resolvePublicInvoiceCheckout(context.token)
      expect(opened.status).toBe("redirect")
      expect(opened.url).not.toBe("https://checkout.stripe.test/stale")
      expect(expiredSessions()).toContain(`cs_stale_${context.invoiceId}`)
      expect(createCheckoutSession).toHaveBeenLastCalledWith(expect.objectContaining({ amountDue: 60 }))
    })

    it("does not expire the session a Stripe payment came from, but expires the one it replaces", async () => {
      const context = await setup()
      // The customer started an asynchronous payment in one session, then opened another.
      const asyncSession = `cs_async_${context.invoiceId}`
      const open = await openCheckout(context)

      const recorded = await processStripeWebhookEvent(
        {
          type: "checkout.session.async_payment_succeeded",
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              id: asyncSession,
              payment_intent: `pi_${asyncSession}`,
              client_reference_id: context.invoiceId,
              amount_total: 10_000,
              currency: "usd",
              payment_status: "paid",
              metadata: { invoiceId: context.invoiceId },
            },
          },
        },
        { organizationId: context.org.organizationId }
      )
      expect(recorded).toEqual({ handled: true, alreadyApplied: false })
      expect(expiredSessions()).toEqual([open])
    })
  })

  describe("an invoice credited in full", () => {
    it("keeps its emailed payment link working and shows it as settled", async () => {
      const { org, invoiceId, token } = await setup()
      const credited = await executeIssuanceCommand(
        issueCreditNote,
        { invoiceId, reason: "Cancelled", mode: "full" },
        { actor: org.actors.admin }
      )
      if (credited.status !== "completed") throw new Error(JSON.stringify(credited))
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("credited")

      const session = await loadPublicInvoiceByToken(token, paymentSecret)
      expect(session).not.toBeNull()
      if (!session) return
      const page = serializePublicInvoiceSession(session)
      expect(page.paymentState).toBe("paid")
      expect(page.invoice).toMatchObject({ status: "credited", amountCredited: 100, balanceDue: 0 })

      expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "paid", url: null })
      expect(createCheckoutSession).not.toHaveBeenCalled()
    })
  })
})
