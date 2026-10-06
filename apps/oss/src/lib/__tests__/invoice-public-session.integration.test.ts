import "dotenv/config"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "../db"
import { resolvePublicInvoiceCheckout } from "../payments/public-checkout"
import { appRouter } from "../../trpc/router"
import { ensureTestMembership } from "../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

describeIfDatabase("public invoice checkout session", () => {
  it("distinguishes invalid, unavailable, and already-paid payment link states", async () => {
    const orgId = randomUUID()
    const slug = `invoice-session-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
    const previousOrigin = process.env.YAIP_APP_ORIGIN
    const previousSecret = process.env.YAIP_PUBLIC_PAYMENT_SECRET
    const previousResendApiKey = process.env.RESEND_API_KEY
    const previousFromEmail = process.env.FROM_EMAIL

    process.env.YAIP_APP_ORIGIN = "https://app.example.test"
    process.env.YAIP_PUBLIC_PAYMENT_SECRET = "payment-link-secret-123456"
    delete process.env.RESEND_API_KEY
    delete process.env.FROM_EMAIL

    const caller = appRouter.createCaller({
      session: {
        user: {
          id: "invoice-session-user",
          email: "invoice-session@example.com",
          name: "Invoice Session User",
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
          name: "Invoice Session Org",
          slug,
          createdAt: new Date(),
          subscriptionStatus: "pro",
        },
      })
      await ensureTestMembership(orgId, "invoice-session-user")

      await prisma.orgSettings.create({
        data: {
          organizationId: orgId,
          countryCode: "DK",
          locale: "da-DK",
          timezone: "Europe/Copenhagen",
          defaultCurrency: "DKK",
          currency: "DKK",
          taxRegime: "eu_vat",
          pricesIncludeTax: false,
          invoicePrefix: "INVSES",
          quotePrefix: "QTESES",
          stripePublishableKey: "pk_test_123456789",
          stripeSecretKeyEnc: "not-used-here",
          stripeWebhookSecretEnc: "not-used-here",
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

      const sentInvoice = await caller.invoices.send({
        id: invoice.id,
        allowSendWithoutEmail: true,
      })

      expect(sentInvoice.emailSent).toBe(false)
      expect(sentInvoice.emailSkipReason).toBe("Email delivery is not configured")

      const paymentLink = await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          publicPaymentIssuedAt: new Date(),
        },
        select: {
          id: true,
          publicPaymentIssuedAt: true,
          publicPaymentKeyVersion: true,
        },
      })

      const token = (
        await caller.invoices.createPaymentLink({
          id: paymentLink.id,
        })
      ).url.split("/pay/")[1]

      expect(
        await resolvePublicInvoiceCheckout("invalid-token")
      ).toEqual({
        status: "invalid",
        url: null,
      })

      await prisma.orgSettings.update({
        where: { organizationId: orgId },
        data: {
          stripePublishableKey: null,
          stripeSecretKeyEnc: null,
          stripeWebhookSecretEnc: null,
        },
      })

      expect(
        await resolvePublicInvoiceCheckout(decodeURIComponent(token ?? ""))
      ).toEqual({
        status: "unavailable",
        url: null,
      })

      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: "paid",
          paymentStatus: "paid",
          paidAt: new Date(),
        },
      })

      expect(
        await resolvePublicInvoiceCheckout(decodeURIComponent(token ?? ""))
      ).toEqual({
        status: "paid",
        url: null,
      })
    } finally {
      process.env.YAIP_APP_ORIGIN = previousOrigin
      process.env.YAIP_PUBLIC_PAYMENT_SECRET = previousSecret
      process.env.RESEND_API_KEY = previousResendApiKey
      process.env.FROM_EMAIL = previousFromEmail
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })
})
