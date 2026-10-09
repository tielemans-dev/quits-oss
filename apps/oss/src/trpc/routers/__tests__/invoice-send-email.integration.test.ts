import { cleanupTestOrganizations } from "../../../test-utils/organization"
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/email")>(
    "../../../lib/email"
  )

  return {
    ...actual,
    deliver: vi.fn().mockResolvedValue({ id: "email_123" }),
  }
})

import { prisma } from "../../../lib/db"
import { deliver, EmailSendError } from "../../../lib/email"
import { appRouter } from "../../router"
import { findEmailDeliveryJobs, retryEmailDeliveries } from "../../../test-utils/email-outbox"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
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
      baseCurrency: "DKK",
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
    vi.mocked(deliver).mockReset()
    vi.mocked(deliver).mockResolvedValue({ id: "email_123" })
  })

  it("includes a public payment link in invoice email when Stripe is configured and records a sent attempt", async () => {
    const previous = {
      QUITS_APP_ORIGIN: process.env.QUITS_APP_ORIGIN,
      QUITS_PUBLIC_PAYMENT_SECRET: process.env.QUITS_PUBLIC_PAYMENT_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.QUITS_APP_ORIGIN = "https://app.example.test"
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = "public-payment-secret-123456"
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

      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "buyer@example.com",
          html: expect.stringContaining("https://app.example.test/pay/"),
          from: "Acme via Quits <billing@example.com>",
          replyTo: "billing@acme.com",
        }),
        { provider: "resend", idempotencyKey: expect.stringMatching(new RegExp(`^invoice-send:${invoice.id}:`)) }
      )
    } finally {
      restoreEnv(previous)
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  it("falls back to the shared sender when branded sending is not verified", async () => {
    const previous = {
      QUITS_APP_ORIGIN: process.env.QUITS_APP_ORIGIN,
      QUITS_PUBLIC_PAYMENT_SECRET: process.env.QUITS_PUBLIC_PAYMENT_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.QUITS_APP_ORIGIN = "https://app.example.test"
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = "public-payment-secret-123456"
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@yaip.app"

    const { orgId, caller, invoice } = await createInvoiceFixture({
      configureStripe: true,
      documentSendingDomain: "billing.acme.com",
      documentSendingDomainStatus: "pending_dns",
    })

    try {
      await caller.invoices.send({ id: invoice.id })

      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "Acme via Quits <billing@yaip.app>",
          replyTo: "billing@acme.com",
        }),
        { provider: "resend", idempotencyKey: expect.stringMatching(/^invoice-send:/) }
      )
    } finally {
      restoreEnv(previous)
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  it("sends invoice email without payment CTA when Stripe is not configured and still records a sent attempt", async () => {
    const previous = {
      QUITS_APP_ORIGIN: process.env.QUITS_APP_ORIGIN,
      QUITS_PUBLIC_PAYMENT_SECRET: process.env.QUITS_PUBLIC_PAYMENT_SECRET,
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
      expect(deliver).toHaveBeenCalledTimes(1)
      const [message, options] = vi.mocked(deliver).mock.calls[0]!
      expect(message.to).toBe("buyer@example.com")
      expect(message.html).not.toContain("/pay/")
      expect(options).toEqual({ provider: "resend", idempotencyKey: expect.stringMatching(/^invoice-send:/) })
    } finally {
      restoreEnv(previous)
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  it("rejects send when email delivery is not configured unless degraded send is explicitly allowed", async () => {
    const previous = {
      QUITS_APP_ORIGIN: process.env.QUITS_APP_ORIGIN,
      QUITS_PUBLIC_PAYMENT_SECRET: process.env.QUITS_PUBLIC_PAYMENT_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.QUITS_APP_ORIGIN = "https://app.example.test"
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = "public-payment-secret-123456"
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
      expect(deliver).not.toHaveBeenCalled()
    } finally {
      restoreEnv(previous)
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  it("keeps the invoice sending after an uncertain failure, then delivers the same message on retry", async () => {
    const previous = {
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"
    // A network error: the provider may or may not have accepted the email.
    vi.mocked(deliver).mockRejectedValueOnce(new Error("socket hang up"))

    const { orgId, caller, invoice } = await createInvoiceFixture()

    try {
      const result = await caller.invoices.send({ id: invoice.id })
      expect(result.emailSent).toBe(false)
      expect(result.emailPending).toBe(true)

      const frozen = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(frozen.status).toBe("draft")
      expect(frozen.lastEmailAttemptOutcome).toBe("sending")
      const [job] = await findEmailDeliveryJobs(orgId)
      expect(job?.status).toBe("pending")
      expect(job?.attempts).toBe(1)

      // While delivery may have happened, the invoice cannot change or be sent again.
      await expect(
        caller.invoices.update({ id: invoice.id, notes: "changed after delivery" })
      ).rejects.toThrow(/being emailed/)
      await expect(caller.invoices.send({ id: invoice.id })).rejects.toThrow(/being emailed/)

      await retryEmailDeliveries(orgId)
      const sent = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(sent.status).toBe("sent")
      expect(sent.lastEmailAttemptOutcome).toBe("sent")
      expect(sent.issueDate.getTime()).toBe(frozen.lastEmailAttemptAt?.getTime())

      // The retry replays the stored message under the same key, so the provider sends one email.
      const calls = vi.mocked(deliver).mock.calls
      expect(calls).toHaveLength(2)
      expect(calls[1]![0]).toEqual(calls[0]![0])
      expect(calls[1]![1]).toEqual(calls[0]![1])
      expect(calls[0]![1]?.idempotencyKey).toMatch(new RegExp(`^invoice-send:${invoice.id}:`))
    } finally {
      restoreEnv(previous)
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  it("records a failed attempt and keeps the invoice in draft when provider delivery throws", async () => {
    const previous = {
      QUITS_APP_ORIGIN: process.env.QUITS_APP_ORIGIN,
      QUITS_PUBLIC_PAYMENT_SECRET: process.env.QUITS_PUBLIC_PAYMENT_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.QUITS_APP_ORIGIN = "https://app.example.test"
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = "public-payment-secret-123456"
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"
    vi.mocked(deliver).mockRejectedValueOnce(
      new EmailSendError("validation_error", "Domain is not verified")
    )

    const { orgId, caller, invoice } = await createInvoiceFixture({ configureStripe: true })

    try {
      await expect(caller.invoices.send({ id: invoice.id })).rejects.toThrow(
        "The email provider refused the email. Check the email configuration."
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
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  it("blocks email send when the contact has no email address", async () => {
    const previous = {
      QUITS_APP_ORIGIN: process.env.QUITS_APP_ORIGIN,
      QUITS_PUBLIC_PAYMENT_SECRET: process.env.QUITS_PUBLIC_PAYMENT_SECRET,
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
      expect(deliver).not.toHaveBeenCalled()
    } finally {
      restoreEnv(previous)
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  it("resends email for a sent invoice without rotating the public payment link", async () => {
    const previous = {
      QUITS_APP_ORIGIN: process.env.QUITS_APP_ORIGIN,
      QUITS_PUBLIC_PAYMENT_SECRET: process.env.QUITS_PUBLIC_PAYMENT_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.QUITS_APP_ORIGIN = "https://app.example.test"
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = "public-payment-secret-123456"
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"

    const { orgId, caller, invoice } = await createInvoiceFixture({ configureStripe: true })

    try {
      await caller.invoices.send({ id: invoice.id })
      const firstCall = vi.mocked(deliver).mock.calls[0]?.[0]

      vi.mocked(deliver).mockClear()

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

      const secondCall = vi.mocked(deliver).mock.calls[0]
      const paymentUrl = (html: string | undefined) => html?.match(/https:\/\/app\.example\.test\/pay\/[^"'<\s]+/)?.[0]

      expect(reloaded.status).toBe("sent")
      expect(reloaded.publicPaymentIssuedAt).toBeTruthy()
      expect(reloaded.lastEmailAttemptOutcome).toBe("sent")
      expect(paymentUrl(firstCall?.html)).toBeTruthy()
      expect(paymentUrl(secondCall?.[0].html)).toBe(paymentUrl(firstCall?.html))
      expect(secondCall?.[1]).toEqual({ provider: "resend", idempotencyKey: expect.stringMatching(/^invoice-resend:/) })
    } finally {
      restoreEnv(previous)
      await cleanupTestOrganizations({ where: { id: orgId } })
    }
  })

  describe("language of the email", () => {
    const envKeys = ["QUITS_APP_ORIGIN", "QUITS_PUBLIC_PAYMENT_SECRET", "RESEND_API_KEY", "FROM_EMAIL"]

    async function withEmailEnv(run: () => Promise<void>) {
      const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
      process.env.QUITS_APP_ORIGIN = "https://app.example.test"
      process.env.QUITS_PUBLIC_PAYMENT_SECRET = "public-payment-secret-123456"
      process.env.RESEND_API_KEY = "resend_test_key"
      process.env.FROM_EMAIL = "billing@example.com"
      try {
        await run()
      } finally {
        restoreEnv(previous)
      }
    }

    const switchOrganizationToEnglish = (orgId: string) =>
      prisma.orgSettings.update({
        where: { organizationId: orgId },
        data: { locale: "en-US", timezone: "America/New_York" },
      })

    it("sends and resends the language the draft was created in after the organization switches language", async () => {
      await withEmailEnv(async () => {
        const { orgId, caller, invoice } = await createInvoiceFixture()
        try {
          expect(invoice.locale).toBe("da-DK")
          await switchOrganizationToEnglish(orgId)

          await caller.invoices.send({ id: invoice.id })
          const sent = vi.mocked(deliver).mock.calls[0]?.[0]
          expect(sent?.subject).toMatch(/^Faktura /)
          expect(sent?.subject).toContain("2.500,00\u00a0kr.")
          expect(sent?.html).toContain("Hej Buyer Name, her er din faktura.")
          expect(sent?.html).not.toContain("please find your invoice")

          vi.mocked(deliver).mockClear()
          await caller.invoices.resendEmail({ id: invoice.id })
          const resent = vi.mocked(deliver).mock.calls[0]?.[0]
          expect(resent?.subject).toBe(sent?.subject)
          expect(resent?.html).toContain("Hej Buyer Name, her er din faktura.")
        } finally {
          await cleanupTestOrganizations({ where: { id: orgId } })
        }
      })
    })

    it("falls back to the organization's language for a legacy invoice without its own", async () => {
      await withEmailEnv(async () => {
        const { orgId, caller, invoice } = await createInvoiceFixture()
        try {
          await prisma.invoice.update({ where: { id: invoice.id }, data: { locale: "", timezone: "" } })
          await switchOrganizationToEnglish(orgId)

          await caller.invoices.send({ id: invoice.id })
          const sent = vi.mocked(deliver).mock.calls[0]?.[0]
          expect(sent?.subject).toMatch(/^Invoice /)
          expect(sent?.html).toContain("Hi Buyer Name, please find your invoice below.")
        } finally {
          await cleanupTestOrganizations({ where: { id: orgId } })
        }
      })
    })
  })

})
