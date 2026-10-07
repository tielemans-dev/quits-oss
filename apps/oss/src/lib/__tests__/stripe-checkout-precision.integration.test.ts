import "dotenv/config"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContact } from "../../domain/commands/contacts"
import { createInvoiceDraft, sendInvoice } from "../../domain/commands/invoices"
import { executeCommand } from "../../domain/execute"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { prisma } from "../db"
import { signInvoicePaymentToken } from "../payments/public"
import { resolvePublicInvoiceCheckout } from "../payments/public-checkout"
import { encryptSecret } from "../secrets"

const createCheckoutSession = vi.hoisted(() => vi.fn())

vi.mock("../payments/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../payments/stripe")>()),
  createStripeInvoiceCheckoutSession: createCheckoutSession,
}))

const describeIfDatabase = hasTestDatabase ? describe : describe.skip
const paymentSecret = "payment-link-secret-precision-123456"

describeIfDatabase("public invoice checkout amount precision", () => {
  const cleanups: Array<() => Promise<void>> = []
  const previousSecret = process.env.QUITS_PUBLIC_PAYMENT_SECRET

  beforeEach(() => {
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = paymentSecret
    createCheckoutSession.mockReset()
    createCheckoutSession.mockResolvedValue({ id: "cs_precision", url: "https://checkout.stripe.test/cs" })
  })

  afterEach(async () => {
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = previousSecret
    while (cleanups.length) await cleanups.pop()?.()
  })

  /** A sent JPY invoice with a public payment link and Stripe configured. */
  async function setupJpyInvoice(unitPrice: number) {
    const org = await createTestOrganization({ settings: { currency: "JPY" } })
    cleanups.push(org.cleanup)
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
      { name: "Tokyo Buyer", email: "buyer@example.jp" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    const draft = await executeCommand(
      createInvoiceDraft,
      {
        contactId: contact.result.id,
        dueDate: "2099-12-01",
        currency: "JPY",
        taxRate: 0,
        items: [{ description: "Consulting", quantity: 1, unitPrice }],
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
    // New JPY documents are priced in whole yen; fractional totals only exist on invoices created
    // before that, so set the total directly to cover them.
    const invoice = await prisma.invoice.update({
      where: { id: draft.result.id },
      data: { publicPaymentIssuedAt: new Date(), subtotalNet: unitPrice, totalGross: unitPrice },
    })
    return signInvoicePaymentToken(
      { invoiceId: invoice.id, keyVersion: invoice.publicPaymentKeyVersion, scope: "invoice_payment" },
      paymentSecret
    )
  }

  it("refuses to open a checkout for a balance the currency cannot charge exactly", async () => {
    for (const unitPrice of [100.49, 100.5]) {
      const token = await setupJpyInvoice(unitPrice)
      expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "unavailable", url: null })
    }
    expect(createCheckoutSession).not.toHaveBeenCalled()
  })

  it("opens a checkout for a whole-yen balance", async () => {
    const token = await setupJpyInvoice(100)
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({
      status: "redirect",
      url: "https://checkout.stripe.test/cs",
    })
    expect(createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ amountDue: 100 }))
  })
})
