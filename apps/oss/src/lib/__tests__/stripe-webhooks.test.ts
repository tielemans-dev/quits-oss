import "dotenv/config"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "../db"
import { encryptSecret } from "../secrets"
import { createStripeClient } from "../payments/stripe"
import { processStripeWebhookRequest } from "../payments/webhooks"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

describeIfDatabase("stripe webhook settlement", () => {
  it("marks invoices paid and handles repeated deliveries idempotently", async () => {
    const orgId = randomUUID()
    const contactId = randomUUID()
    const slug = `stripe-webhook-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
    const webhookSecret = "whsec_test_12345678901234567890"

    try {
      await prisma.organization.create({
        data: {
          id: orgId,
          name: "Stripe Webhook Org",
          slug,
          createdAt: new Date(),
          subscriptionStatus: "pro",
        },
      })

      await prisma.orgSettings.create({
        data: {
          organizationId: orgId,
          stripePublishableKey: "pk_test_123456789",
          stripeSecretKeyEnc: encryptSecret("sk_test_12345678901234567890"),
          stripeWebhookSecretEnc: encryptSecret(webhookSecret),
        },
      })

      await prisma.contact.create({
        data: {
          id: contactId,
          organizationId: orgId,
          name: "Webhook Buyer",
          email: "buyer@example.com",
        },
      })

      const invoice = await prisma.invoice.create({
        data: {
          organizationId: orgId,
          contactId,
          number: "INV-WEBHOOK-1",
          status: "sent",
          paymentStatus: "unpaid",
          publicPaymentIssuedAt: new Date("2026-03-06T00:00:00.000Z"),
          dueDate: new Date("2026-03-20T00:00:00.000Z"),
          subtotalNet: "100.00",
          totalTax: "0.00",
          totalGross: "100.00",
          currency: "USD",
          countryCode: "US",
          locale: "en-US",
          timezone: "UTC",
          taxRegime: "us_sales_tax",
          pricesIncludeTax: false,
        },
      })

      const payload = JSON.stringify({
        id: "evt_test_1",
        object: "event",
        type: "checkout.session.completed",
        created: 1_772_761_600,
        data: {
          object: {
            id: "cs_test_123",
            object: "checkout.session",
            payment_intent: "pi_test_123",
            payment_status: "paid",
            amount_total: 10_000,
            currency: "usd",
            client_reference_id: invoice.id,
            metadata: {
              invoiceId: invoice.id,
              organizationId: orgId,
            },
          },
        },
      })

      const stripe = createStripeClient("sk_test_12345678901234567890")
      const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: webhookSecret,
      })

      const first = await processStripeWebhookRequest(payload, signature)
      expect(first.handled).toBe(true)
      expect(first.alreadyApplied).toBe(false)

      const afterFirst = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      })
      expect(afterFirst.paymentStatus).toBe("paid")
      expect(afterFirst.status).toBe("paid")
      expect(afterFirst.stripeCheckoutSessionId).toBe("cs_test_123")
      expect(afterFirst.stripePaymentIntentId).toBe("pi_test_123")

      const second = await processStripeWebhookRequest(payload, signature)
      expect(second.handled).toBe(true)
      expect(second.alreadyApplied).toBe(true)
    } finally {
      await prisma.payment.deleteMany({ where: { organizationId: orgId } })
      await prisma.commandReceipt.deleteMany({ where: { organizationId: orgId } })
      await prisma.organization.deleteMany({
        where: { id: orgId },
      })
    }
  })

  it("delivers events to every organization that shares one webhook secret", async () => {
    const webhookSecret = `whsec_shared_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`
    const stripe = createStripeClient("sk_test_12345678901234567890")
    const orgs: Array<{ orgId: string; invoiceId: string }> = []

    try {
      for (const label of ["A", "B"]) {
        const orgId = randomUUID()
        await prisma.organization.create({
          data: {
            id: orgId,
            name: `Shared Stripe Org ${label}`,
            slug: `shared-stripe-${label.toLowerCase()}-${orgId.slice(0, 8)}`,
            createdAt: new Date(),
          },
        })
        await prisma.orgSettings.create({
          data: {
            organizationId: orgId,
            stripePublishableKey: "pk_test_123456789",
            stripeSecretKeyEnc: encryptSecret("sk_test_12345678901234567890"),
            stripeWebhookSecretEnc: encryptSecret(webhookSecret),
          },
        })
        const contact = await prisma.contact.create({
          data: { organizationId: orgId, name: `Buyer ${label}`, email: `buyer-${label}@example.com` },
        })
        const invoice = await prisma.invoice.create({
          data: {
            organizationId: orgId,
            contactId: contact.id,
            number: `INV-SHARED-${label}`,
            status: "sent",
            paymentStatus: "unpaid",
            dueDate: new Date("2099-03-20T00:00:00.000Z"),
            subtotalNet: "100.00",
            totalTax: "0.00",
            totalGross: "100.00",
            currency: "USD",
            countryCode: "US",
            locale: "en-US",
            timezone: "UTC",
            taxRegime: "us_sales_tax",
            pricesIncludeTax: false,
          },
        })
        orgs.push({ orgId, invoiceId: invoice.id })
      }

      // Whichever organization the secret lookup tries first, one of these two events belongs to
      // the other organization and must still be delivered.
      for (const { invoiceId } of orgs) {
        const payload = JSON.stringify({
          id: `evt_${invoiceId}`,
          object: "event",
          type: "checkout.session.completed",
          created: 1_772_761_600,
          data: {
            object: {
              id: `cs_shared_${invoiceId}`,
              object: "checkout.session",
              payment_intent: `pi_shared_${invoiceId}`,
              payment_status: "paid",
              amount_total: 10_000,
              currency: "usd",
              client_reference_id: invoiceId,
              metadata: { invoiceId },
            },
          },
        })
        const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret })
        const result = await processStripeWebhookRequest(payload, signature)
        expect(result).toEqual({ handled: true, alreadyApplied: false })

        const settled = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
        expect(settled.paymentStatus).toBe("paid")
      }

      for (const { orgId, invoiceId } of orgs) {
        const payments = await prisma.payment.findMany({ where: { invoiceId } })
        expect(payments).toHaveLength(1)
        expect(payments[0]?.organizationId).toBe(orgId)
      }
    } finally {
      for (const { orgId } of orgs) {
        await prisma.payment.deleteMany({ where: { organizationId: orgId } })
        await prisma.commandReceipt.deleteMany({ where: { organizationId: orgId } })
        await prisma.organization.deleteMany({ where: { id: orgId } })
      }
    }
  })
})
