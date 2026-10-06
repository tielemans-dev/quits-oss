import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/email")>(
    "../../../lib/email"
  )

  return {
    ...actual,
    sendInvoiceEmail: vi.fn().mockResolvedValue({ id: "email_123" }),
  }
})

import { prisma } from "../../../lib/db"
import { sendInvoiceEmail } from "../../../lib/email"
import { appRouter } from "../../router"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

function restoreEnv(previous: Record<string, string | undefined>) {
  process.env.YAIP_APP_ORIGIN = previous.YAIP_APP_ORIGIN
  process.env.YAIP_PUBLIC_PAYMENT_SECRET = previous.YAIP_PUBLIC_PAYMENT_SECRET
  process.env.RESEND_API_KEY = previous.RESEND_API_KEY
  process.env.FROM_EMAIL = previous.FROM_EMAIL
}

async function createInvoiceFixture(options?: {
  contactEmail?: string | null
  configureStripe?: boolean
  documentSendingDomain?: string | null
  documentSendingDomainStatus?: string | null
}) {
  const orgId = randomUUID()
  const slug = `invoice-send-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
  const caller = appRouter.createCaller({
    session: {
      user: {
        id: "invoice-send-user",
        email: "invoice-send@example.com",
        name: "Invoice Send User",
      },
      session: {
        activeOrganizationId: orgId,
      },
    },
  } as never)

  await prisma.organization.create({
    data: {
      id: orgId,
      name: "Invoice Send Org",
      slug,
      createdAt: new Date(),
      subscriptionStatus: "pro",
    },
  })
  await ensureTestMembership(orgId, "invoice-send-user")

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
      companyName: "Acme",
      companyEmail: "billing@acme.com",
      invoicePrefix: "INVEML",
      quotePrefix: "QTEEML",
      documentSendingDomain: options?.documentSendingDomain ?? null,
      documentSendingDomainStatus: options?.documentSendingDomainStatus ?? null,
    },
  })

  if (options?.configureStripe) {
    await caller.settings.update({
      stripePublishableKey: "pk_test_123456789",
      stripeSecretKey: "sk_test_12345678901234567890",
      stripeWebhookSecret: "whsec_12345678901234567890",
    })
  }

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
      email:
        options?.contactEmail === undefined ? "buyer@example.com" : options.contactEmail,
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

  return { orgId, caller, invoice }
}

describeIfDatabase("invoice send email delivery", () => {
  afterEach(() => {
    vi.mocked(sendInvoiceEmail).mockReset()
    vi.mocked(sendInvoiceEmail).mockResolvedValue({ id: "email_123" })
  })

  it("includes a public payment link in invoice email when Stripe is configured and records a sent attempt", async () => {
    const previous = {
      YAIP_APP_ORIGIN: process.env.YAIP_APP_ORIGIN,
      YAIP_PUBLIC_PAYMENT_SECRET: process.env.YAIP_PUBLIC_PAYMENT_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.YAIP_APP_ORIGIN = "https://app.example.test"
    process.env.YAIP_PUBLIC_PAYMENT_SECRET = "public-payment-secret-123456"
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"

    const { orgId, caller, invoice } = await createInvoiceFixture({ configureStripe: true })

    try {
      const result = await caller.invoices.send({ id: invoice.id })

      expect(result.emailSent).toBe(true)

      const reloaded = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        select: {
          status: true,
          publicPaymentIssuedAt: true,
          lastEmailAttemptOutcome: true,
          lastEmailAttemptCode: true,
        },
      })

      expect(reloaded.status).toBe("sent")
      expect(reloaded.publicPaymentIssuedAt).toBeTruthy()
      expect(reloaded.lastEmailAttemptOutcome).toBe("sent")
      expect(reloaded.lastEmailAttemptCode).toBe("sent")

      expect(sendInvoiceEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "buyer@example.com",
          publicPaymentUrl: expect.stringContaining("https://app.example.test/pay/"),
          fromName: "Acme via YAIP",
          fromEmail: "billing@example.com",
          replyTo: "billing@acme.com",
        }),
        expect.objectContaining({ idempotencyScope: expect.stringMatching(/^invoice-(send|resend):/) })
      )
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("falls back to the shared sender when branded sending is not verified", async () => {
    const previous = {
      YAIP_APP_ORIGIN: process.env.YAIP_APP_ORIGIN,
      YAIP_PUBLIC_PAYMENT_SECRET: process.env.YAIP_PUBLIC_PAYMENT_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.YAIP_APP_ORIGIN = "https://app.example.test"
    process.env.YAIP_PUBLIC_PAYMENT_SECRET = "public-payment-secret-123456"
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@yaip.app"

    const { orgId, caller, invoice } = await createInvoiceFixture({
      configureStripe: true,
      documentSendingDomain: "billing.acme.com",
      documentSendingDomainStatus: "pending_dns",
    })

    try {
      await caller.invoices.send({ id: invoice.id })

      expect(sendInvoiceEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          fromName: "Acme via YAIP",
          fromEmail: "billing@yaip.app",
          replyTo: "billing@acme.com",
        }),
        expect.objectContaining({ idempotencyScope: expect.stringMatching(/^invoice-(send|resend):/) })
      )
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("sends invoice email without payment CTA when Stripe is not configured and still records a sent attempt", async () => {
    const previous = {
      YAIP_APP_ORIGIN: process.env.YAIP_APP_ORIGIN,
      YAIP_PUBLIC_PAYMENT_SECRET: process.env.YAIP_PUBLIC_PAYMENT_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"

    const { orgId, caller, invoice } = await createInvoiceFixture()

    try {
      const result = await caller.invoices.send({ id: invoice.id })

      expect(result.emailSent).toBe(true)

      const reloaded = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        select: {
          status: true,
          publicPaymentIssuedAt: true,
          lastEmailAttemptOutcome: true,
        },
      })

      expect(reloaded.status).toBe("sent")
      expect(reloaded.publicPaymentIssuedAt).toBeNull()
      expect(reloaded.lastEmailAttemptOutcome).toBe("sent")
      expect(sendInvoiceEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "buyer@example.com",
          publicPaymentUrl: null,
        }),
        expect.objectContaining({ idempotencyScope: expect.stringMatching(/^invoice-(send|resend):/) })
      )
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("rejects send when email delivery is not configured unless degraded send is explicitly allowed", async () => {
    const previous = {
      YAIP_APP_ORIGIN: process.env.YAIP_APP_ORIGIN,
      YAIP_PUBLIC_PAYMENT_SECRET: process.env.YAIP_PUBLIC_PAYMENT_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.YAIP_APP_ORIGIN = "https://app.example.test"
    process.env.YAIP_PUBLIC_PAYMENT_SECRET = "public-payment-secret-123456"
    delete process.env.RESEND_API_KEY
    delete process.env.FROM_EMAIL

    const { orgId, caller, invoice } = await createInvoiceFixture({ configureStripe: true })

    try {
      await expect(caller.invoices.send({ id: invoice.id })).rejects.toThrow(
        "Email delivery is not configured"
      )

      const draft = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        select: {
          status: true,
          publicPaymentIssuedAt: true,
          lastEmailAttemptAt: true,
        },
      })

      expect(draft.status).toBe("draft")
      expect(draft.publicPaymentIssuedAt).toBeNull()
      expect(draft.lastEmailAttemptAt).toBeNull()

      const degraded = await caller.invoices.send({
        id: invoice.id,
        allowSendWithoutEmail: true,
      })

      expect(degraded.emailSent).toBe(false)
      expect(degraded.emailSkipReason).toBe("Email delivery is not configured")

      const reloaded = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        select: {
          status: true,
          publicPaymentIssuedAt: true,
          lastEmailAttemptOutcome: true,
          lastEmailAttemptCode: true,
        },
      })

      expect(reloaded.status).toBe("sent")
      expect(reloaded.publicPaymentIssuedAt).toBeTruthy()
      expect(reloaded.lastEmailAttemptOutcome).toBe("skipped")
      expect(reloaded.lastEmailAttemptCode).toBe("provider_missing")
      expect(sendInvoiceEmail).not.toHaveBeenCalled()
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("records a failed attempt and keeps the invoice in draft when provider delivery throws", async () => {
    const previous = {
      YAIP_APP_ORIGIN: process.env.YAIP_APP_ORIGIN,
      YAIP_PUBLIC_PAYMENT_SECRET: process.env.YAIP_PUBLIC_PAYMENT_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.YAIP_APP_ORIGIN = "https://app.example.test"
    process.env.YAIP_PUBLIC_PAYMENT_SECRET = "public-payment-secret-123456"
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"
    vi.mocked(sendInvoiceEmail).mockRejectedValueOnce(new Error("send failed"))

    const { orgId, caller, invoice } = await createInvoiceFixture({ configureStripe: true })

    try {
      await expect(caller.invoices.send({ id: invoice.id })).rejects.toThrow(
        "Failed to send invoice email. Invoice was not marked as sent."
      )

      const reloaded = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        select: {
          status: true,
          publicPaymentIssuedAt: true,
          lastEmailAttemptOutcome: true,
          lastEmailAttemptCode: true,
        },
      })

      expect(reloaded.status).toBe("draft")
      expect(reloaded.publicPaymentIssuedAt).toBeNull()
      expect(reloaded.lastEmailAttemptOutcome).toBe("failed")
      expect(reloaded.lastEmailAttemptCode).toBe("send_failed")
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("blocks email send when the contact has no email address", async () => {
    const previous = {
      YAIP_APP_ORIGIN: process.env.YAIP_APP_ORIGIN,
      YAIP_PUBLIC_PAYMENT_SECRET: process.env.YAIP_PUBLIC_PAYMENT_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"

    const { orgId, caller, invoice } = await createInvoiceFixture({ contactEmail: null })

    try {
      await expect(caller.invoices.send({ id: invoice.id })).rejects.toThrow(
        "Contact has no email address"
      )

      const reloaded = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        select: {
          status: true,
          publicPaymentIssuedAt: true,
          lastEmailAttemptAt: true,
        },
      })

      expect(reloaded.status).toBe("draft")
      expect(reloaded.publicPaymentIssuedAt).toBeNull()
      expect(reloaded.lastEmailAttemptAt).toBeNull()
      expect(sendInvoiceEmail).not.toHaveBeenCalled()
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("resends email for a sent invoice without rotating the public payment link", async () => {
    const previous = {
      YAIP_APP_ORIGIN: process.env.YAIP_APP_ORIGIN,
      YAIP_PUBLIC_PAYMENT_SECRET: process.env.YAIP_PUBLIC_PAYMENT_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.YAIP_APP_ORIGIN = "https://app.example.test"
    process.env.YAIP_PUBLIC_PAYMENT_SECRET = "public-payment-secret-123456"
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"

    const { orgId, caller, invoice } = await createInvoiceFixture({ configureStripe: true })

    try {
      await caller.invoices.send({ id: invoice.id })
      const firstCall = vi.mocked(sendInvoiceEmail).mock.calls[0]?.[0]

      vi.mocked(sendInvoiceEmail).mockClear()

      const resend = await caller.invoices.resendEmail({ id: invoice.id })
      expect(resend.emailSent).toBe(true)

      const reloaded = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        select: {
          status: true,
          publicPaymentIssuedAt: true,
          lastEmailAttemptOutcome: true,
        },
      })

      const secondCall = vi.mocked(sendInvoiceEmail).mock.calls[0]?.[0]

      expect(reloaded.status).toBe("sent")
      expect(reloaded.publicPaymentIssuedAt).toBeTruthy()
      expect(reloaded.lastEmailAttemptOutcome).toBe("sent")
      expect(secondCall?.publicPaymentUrl).toBe(firstCall?.publicPaymentUrl)
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })
})
