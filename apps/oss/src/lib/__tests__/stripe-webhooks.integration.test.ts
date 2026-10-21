import { cleanupTestOrganizations } from "../../test-utils/organization"
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../db"
import { encryptSecret } from "../secrets"
import { createStripeClient } from "../payments/stripe"
import { processStripeWebhookRequest } from "../payments/webhooks"
import { setRuntimeExtensions } from "../runtime/extensions"

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
      await cleanupTestOrganizations({
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
        await cleanupTestOrganizations({ where: { id: orgId } })
      }
    }
  })
})

describeIfDatabase("stripe connect webhook verifier", () => {
  afterEach(() => {
    setRuntimeExtensions([])
  })

  async function organizationForConnectedAccount(stripeAccountId: string) {
    const settings = await prisma.orgSettings.findUnique({
      where: { stripeAccountId },
      select: { organizationId: true },
    })
    return settings?.organizationId ?? null
  }

  function useConnectVerifier(
    webhookSecret: string,
    resolveOrganizationId: (stripeAccountId: string) => Promise<string | null> = organizationForConnectedAccount
  ) {
    setRuntimeExtensions([
      {
        id: "stripe-connect-test",
        resolveStripeConnectWebhook: () => ({
          webhookSecret,
          resolveOrganizationId,
        }),
      },
    ])
  }

  async function createWebhookOrg(input: {
    label: string
    webhookSecret?: string
    stripeAccountId?: string
  }) {
    const orgId = randomUUID()
    await prisma.organization.create({
      data: {
        id: orgId,
        name: `Connect Webhook ${input.label}`,
        slug: `connect-webhook-${input.label}-${orgId.slice(0, 8)}`,
        createdAt: new Date(),
      },
    })
    await prisma.orgSettings.create({
      data: {
        organizationId: orgId,
        stripePublishableKey: input.webhookSecret ? "pk_test_123456789" : null,
        stripeSecretKeyEnc: input.webhookSecret ? encryptSecret("sk_test_12345678901234567890") : null,
        stripeWebhookSecretEnc: input.webhookSecret ? encryptSecret(input.webhookSecret) : null,
        stripeAccountId: input.stripeAccountId ?? null,
      },
    })
    const contact = await prisma.contact.create({
      data: {
        organizationId: orgId,
        name: `Buyer ${input.label}`,
        email: `${input.label}-${orgId.slice(0, 8)}@example.com`,
      },
    })
    const invoice = await prisma.invoice.create({
      data: {
        organizationId: orgId,
        contactId: contact.id,
        number: `INV-CONNECT-${input.label}`,
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
    return { orgId, invoiceId: invoice.id }
  }

  async function cleanupOrgs(orgIds: string[]) {
    for (const orgId of orgIds) {
      await prisma.payment.deleteMany({ where: { organizationId: orgId } })
      await prisma.commandReceipt.deleteMany({ where: { organizationId: orgId } })
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  }

  function signedCheckoutEvent(input: {
    secret: string
    invoiceId: string
    sessionId: string
    account?: string
  }) {
    const payload = JSON.stringify({
      id: `evt_${input.sessionId}`,
      object: "event",
      ...(input.account ? { account: input.account } : {}),
      type: "checkout.session.completed",
      created: 1_772_761_600,
      data: {
        object: {
          id: input.sessionId,
          object: "checkout.session",
          payment_intent: `pi_${input.sessionId}`,
          payment_status: "paid",
          amount_total: 10_000,
          currency: "usd",
          client_reference_id: input.invoiceId,
          metadata: { invoiceId: input.invoiceId },
        },
      },
    })
    const signature = createStripeClient("sk_test_12345678901234567890").webhooks.generateTestHeaderString({
      payload,
      secret: input.secret,
    })
    return { payload, signature }
  }

  it("settles the organization that owns the connected account and ignores a replay", async () => {
    const connectSecret = `whsec_connect_${randomUUID()}`
    const accountId = `acct_${randomUUID().replaceAll("-", "")}`
    const org = await createWebhookOrg({ label: "owner", stripeAccountId: accountId })

    try {
      useConnectVerifier(connectSecret)
      const signed = signedCheckoutEvent({
        secret: connectSecret,
        invoiceId: org.invoiceId,
        sessionId: `cs_connect_${org.invoiceId}`,
        account: accountId,
      })

      const first = await processStripeWebhookRequest(signed.payload, signed.signature)
      expect(first).toEqual({ handled: true, alreadyApplied: false })

      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: org.invoiceId } })
      expect(invoice.paymentStatus).toBe("paid")
      expect(invoice.stripeCheckoutSessionId).toBe(`cs_connect_${org.invoiceId}`)

      const second = await processStripeWebhookRequest(signed.payload, signed.signature)
      expect(second).toEqual({ handled: true, alreadyApplied: true })
      expect(await prisma.payment.count({ where: { invoiceId: org.invoiceId } })).toBe(1)
    } finally {
      await cleanupOrgs([org.orgId])
    }
  })

  it("ignores an event whose connected account is not linked to an organization", async () => {
    const connectSecret = `whsec_connect_${randomUUID()}`
    // The invoice owner also stores the platform secret as a BYOK secret. Falling through
    // after an unknown account would settle this invoice.
    const org = await createWebhookOrg({
      label: "unlinked",
      webhookSecret: connectSecret,
      stripeAccountId: `acct_real_${randomUUID().replaceAll("-", "")}`,
    })

    try {
      useConnectVerifier(connectSecret)
      const signed = signedCheckoutEvent({
        secret: connectSecret,
        invoiceId: org.invoiceId,
        sessionId: `cs_unknown_${org.invoiceId}`,
        account: `acct_unknown_${randomUUID().replaceAll("-", "")}`,
      })

      const result = await processStripeWebhookRequest(signed.payload, signed.signature)
      expect(result).toEqual({ handled: false, alreadyApplied: false })

      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: org.invoiceId } })
      expect(invoice.paymentStatus).toBe("unpaid")
      expect(await prisma.payment.count({ where: { invoiceId: org.invoiceId } })).toBe(0)
    } finally {
      await cleanupOrgs([org.orgId])
    }
  })

  it("ignores an invoice owned by a different organization than the connected account", async () => {
    const connectSecret = `whsec_connect_${randomUUID()}`
    const accountId = `acct_${randomUUID().replaceAll("-", "")}`
    const connected = await createWebhookOrg({ label: "connected", stripeAccountId: accountId })
    // Same secret as the platform, so a fall-through would settle the other organization's invoice.
    const other = await createWebhookOrg({ label: "other", webhookSecret: connectSecret })

    try {
      useConnectVerifier(connectSecret)
      const signed = signedCheckoutEvent({
        secret: connectSecret,
        invoiceId: other.invoiceId,
        sessionId: `cs_foreign_invoice_${other.invoiceId}`,
        account: accountId,
      })

      const result = await processStripeWebhookRequest(signed.payload, signed.signature)
      expect(result).toEqual({ handled: false, alreadyApplied: false })

      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: other.invoiceId } })
      expect(invoice.paymentStatus).toBe("unpaid")
      const connectedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: connected.invoiceId } })
      expect(connectedInvoice.paymentStatus).toBe("unpaid")
      expect(await prisma.payment.count({
        where: { invoiceId: { in: [other.invoiceId, connected.invoiceId] } },
      })).toBe(0)
    } finally {
      await cleanupOrgs([connected.orgId, other.orgId])
    }
  })

  it("still settles an organization secret when the Connect signature does not match", async () => {
    const connectSecret = `whsec_connect_${randomUUID()}`
    const byokSecret = `whsec_byok_${randomUUID()}`
    let lookups = 0
    const org = await createWebhookOrg({ label: "byok", webhookSecret: byokSecret })

    try {
      useConnectVerifier(connectSecret, async () => {
        lookups += 1
        return null
      })
      const signed = signedCheckoutEvent({
        secret: byokSecret,
        invoiceId: org.invoiceId,
        sessionId: `cs_byok_${org.invoiceId}`,
      })

      const result = await processStripeWebhookRequest(signed.payload, signed.signature)
      expect(result).toEqual({ handled: true, alreadyApplied: false })
      expect(lookups).toBe(0)

      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: org.invoiceId } })
      expect(invoice.paymentStatus).toBe("paid")
    } finally {
      await cleanupOrgs([org.orgId])
    }
  })

  it("ignores a platform-signed event that names no connected account", async () => {
    const connectSecret = `whsec_connect_${randomUUID()}`
    // Same secret stored as BYOK, so falling through would settle the invoice.
    const org = await createWebhookOrg({ label: "noaccount", webhookSecret: connectSecret })

    try {
      useConnectVerifier(connectSecret)
      const signed = signedCheckoutEvent({
        secret: connectSecret,
        invoiceId: org.invoiceId,
        sessionId: `cs_noaccount_${org.invoiceId}`,
      })

      const result = await processStripeWebhookRequest(signed.payload, signed.signature)
      expect(result).toEqual({ handled: false, alreadyApplied: false })
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: org.invoiceId } })
      expect(invoice.paymentStatus).toBe("unpaid")
      expect(await prisma.payment.count({ where: { invoiceId: org.invoiceId } })).toBe(0)
    } finally {
      await cleanupOrgs([org.orgId])
    }
  })

  it("rejects a Connect signature when no verifier is registered", async () => {
    const connectSecret = `whsec_connect_${randomUUID()}`
    const accountId = `acct_${randomUUID().replaceAll("-", "")}`
    const org = await createWebhookOrg({ label: "noverifier", stripeAccountId: accountId })

    try {
      setRuntimeExtensions([])
      const signed = signedCheckoutEvent({
        secret: connectSecret,
        invoiceId: org.invoiceId,
        sessionId: `cs_noverifier_${org.invoiceId}`,
        account: accountId,
      })

      await expect(processStripeWebhookRequest(signed.payload, signed.signature)).rejects.toThrow(
        "Invalid Stripe webhook signature"
      )
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: org.invoiceId } })
      expect(invoice.paymentStatus).toBe("unpaid")
    } finally {
      await cleanupOrgs([org.orgId])
    }
  })
})
