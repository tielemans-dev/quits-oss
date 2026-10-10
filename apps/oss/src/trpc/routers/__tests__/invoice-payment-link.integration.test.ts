import { cleanupTestOrganizations } from "../../../test-utils/organization"
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { loadPublicInvoiceByToken } from "../../../lib/payments/public-access"
import { appRouter } from "../../router"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

describeIfDatabase("invoice payment links", () => {
  it("does not backfill historical bank details and still supports card payment links", async () => {
    const orgId = randomUUID()
    const slug = `invoice-link-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
    const previousOrigin = process.env.QUITS_APP_ORIGIN
    const previousSecret = process.env.QUITS_PUBLIC_PAYMENT_SECRET

    process.env.QUITS_APP_ORIGIN = "https://app.example.test"
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = "payment-link-secret-123456"

    const caller = appRouter.createCaller({
      session: {
        user: {
          id: "invoice-link-user",
          email: "invoice-link@example.com",
          name: "Invoice Link User",
        },
        session: {
          activeOrganizationId: orgId,
        },
      },
    } as never)

    try {
      await prisma.organization.create({
        data: {
          id: orgId,
          name: "Invoice Link Org",
          slug,
          createdAt: new Date(),
          subscriptionStatus: "pro",
        },
      })
      await ensureTestMembership(orgId, "invoice-link-user")

      await prisma.orgSettings.create({
        data: {
          organizationId: orgId,
          countryCode: "DK",
          locale: "da-DK",
          timezone: "Europe/Copenhagen",
          defaultCurrency: "DKK",
          baseCurrency: "DKK",
          currency: "DKK",
          taxRegime: "eu_vat",
          pricesIncludeTax: false,
          invoicePrefix: "INVLNK",
          quotePrefix: "QTELNK",
        },
      })

      await prisma.organizationTaxId.create({
        data: {
          organizationId: orgId,
          scheme: "DK_CVR",
          value: "12345678",
          countryCode: "DK",
          isPrimary: true,
        },
      })

      const contact = await prisma.contact.create({
        data: {
          organizationId: orgId,
          name: "Buyer Name",
          email: "buyer@example.com",
          company: "Buyer Co",
          country: "DK",
        },
      })

      const invoice = await caller.invoices.create({
        contactId: contact.id,
        dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        taxRate: 25,
        items: [{ description: "Consulting", quantity: 2, unitPrice: 1000 }],
      })

      await caller.invoices.send({ id: invoice.id, allowSendWithoutEmail: true })

      await expect(caller.invoices.createPaymentLink({ id: invoice.id })).rejects.toThrow(
        "Configure card payments or issue an invoice with bank transfer details"
      )

      // Adding an account today cannot make an older invoice payable to that account.
      await caller.paymentDetails.update({ bankAccount: { regNumber: "0040", accountNumber: "0440116243" } })
      await expect(caller.invoices.createPaymentLink({ id: invoice.id })).rejects.toThrow(
        "Configure card payments or issue an invoice with bank transfer details"
      )
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).publicPaymentIssuedAt).toBeNull()

      await caller.settings.update({
        stripePublishableKey: "pk_test_123456789",
        stripeSecretKey: "sk_test_12345678901234567890",
        stripeWebhookSecret: "whsec_12345678901234567890",
      })

      const paymentLink = await caller.invoices.createPaymentLink({ id: invoice.id })

      expect(paymentLink.url).toContain("https://app.example.test/pay/")

      const token = paymentLink.url.split("/pay/")[1]
      const loaded = await loadPublicInvoiceByToken(
        decodeURIComponent(token ?? ""),
        "payment-link-secret-123456"
      )

      expect(loaded?.invoice.id).toBe(invoice.id)
      expect(loaded?.paymentState).toBe("unpaid")

      await caller.invoices.markPaid({ invoiceId: invoice.id, requestId: crypto.randomUUID() })

      const paidState = await loadPublicInvoiceByToken(
        decodeURIComponent(token ?? ""),
        "payment-link-secret-123456"
      )
      expect(paidState?.paymentState).toBe("paid")

      await expect(caller.invoices.createPaymentLink({ id: invoice.id })).rejects.toThrow(
        "Paid invoices do not need payment links"
      )
    } finally {
      process.env.QUITS_APP_ORIGIN = previousOrigin
      process.env.QUITS_PUBLIC_PAYMENT_SECRET = previousSecret
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })
})
