import "dotenv/config"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContact } from "../../domain/commands/contacts"
import { issueCreditNote } from "../../domain/commands/credit-notes"
import { createInvoiceDraft, sendInvoice } from "../../domain/commands/invoices"
import { executeCommand } from "../../domain/execute"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { prisma } from "../db"
import { signInvoicePaymentToken } from "../payments/public"
import { loadPublicInvoiceByToken } from "../payments/public-access"
import { resolvePublicInvoiceCheckout } from "../payments/public-checkout"
import { serializePublicInvoiceSession } from "../payments/public-session"
import { encryptSecret } from "../secrets"

const createCheckoutSession = vi.hoisted(() => vi.fn())

vi.mock("../payments/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../payments/stripe")>()),
  createStripeInvoiceCheckoutSession: createCheckoutSession,
}))

const describeIfDatabase = hasTestDatabase ? describe : describe.skip
const paymentSecret = "payment-link-secret-settlement-123456"

describeIfDatabase("public invoice links after settlement changes", () => {
  const cleanups: Array<() => Promise<void>> = []
  const previousSecret = process.env.QUITS_PUBLIC_PAYMENT_SECRET

  beforeEach(() => {
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = paymentSecret
    createCheckoutSession.mockReset()
    createCheckoutSession.mockResolvedValue({ id: "cs_settlement", url: "https://checkout.stripe.test/cs" })
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
    const contact = await executeCommand(
      createContact,
      { name: "Buyer", email: "buyer@example.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const draft = await executeCommand(
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
    const sent = await executeCommand(
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

  describe("an invoice credited in full", () => {
    it("keeps its emailed payment link working and shows it as settled", async () => {
      const { org, invoiceId, token } = await setup()
      const credited = await executeCommand(
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
