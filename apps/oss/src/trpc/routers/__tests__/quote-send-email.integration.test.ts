import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/email")>(
    "../../../lib/email"
  )

  return {
    ...actual,
    sendQuoteEmail: vi.fn().mockResolvedValue({ id: "email_123" }),
  }
})

import { prisma } from "../../../lib/db"
import { sendQuoteEmail } from "../../../lib/email"
import { appRouter } from "../../router"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip

function restoreEnv(previous: Record<string, string | undefined>) {
  process.env.YAIP_APP_ORIGIN = previous.YAIP_APP_ORIGIN
  process.env.YAIP_PUBLIC_QUOTE_SECRET = previous.YAIP_PUBLIC_QUOTE_SECRET
  process.env.RESEND_API_KEY = previous.RESEND_API_KEY
  process.env.FROM_EMAIL = previous.FROM_EMAIL
}

async function createQuoteFixture(options?: {
  contactEmail?: string | null
  documentSendingDomain?: string | null
  documentSendingDomainStatus?: string | null
}) {
  const orgId = randomUUID()
  const slug = `quote-send-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
  const caller = appRouter.createCaller({
    session: {
      user: {
        id: "quote-send-user",
        email: "quote-send@example.com",
        name: "Quote Send User",
      },
      session: {
        activeOrganizationId: orgId,
      },
    },
  } as never)

  await prisma.organization.create({
    data: {
      id: orgId,
      name: "Quote Send Org",
      slug,
      createdAt: new Date(),
      subscriptionStatus: "pro",
    },
  })
  await ensureTestMembership(orgId, "quote-send-user")

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

  const quote = await caller.quotes.create({
    contactId: contact.id,
    expiryDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    taxRate: 25,
    items: [{ description: "Consulting", quantity: 2, unitPrice: 1000 }],
  })

  return { orgId, caller, quote }
}

describeIfDatabase("quote send email delivery", () => {
  afterEach(() => {
    vi.mocked(sendQuoteEmail).mockReset()
    vi.mocked(sendQuoteEmail).mockResolvedValue({ id: "email_123" })
  })

  it("issues public quote access on send, records a sent attempt, and passes the link to the email layer", async () => {
    const previous = {
      YAIP_APP_ORIGIN: process.env.YAIP_APP_ORIGIN,
      YAIP_PUBLIC_QUOTE_SECRET: process.env.YAIP_PUBLIC_QUOTE_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.YAIP_APP_ORIGIN = "https://app.example.test"
    process.env.YAIP_PUBLIC_QUOTE_SECRET = "public-quote-secret-123456"
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"

    const { orgId, caller, quote } = await createQuoteFixture()

    try {
      const result = await caller.quotes.send({ id: quote.id })

      expect(result.emailSent).toBe(true)

      const reloaded = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
        select: {
          status: true,
          publicAccessIssuedAt: true,
          lastEmailAttemptOutcome: true,
          lastEmailAttemptCode: true,
        },
      })

      expect(reloaded.status).toBe("sent")
      expect(reloaded.publicAccessIssuedAt).toBeTruthy()
      expect(reloaded.lastEmailAttemptOutcome).toBe("sent")
      expect(reloaded.lastEmailAttemptCode).toBe("sent")

      expect(sendQuoteEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "buyer@example.com",
          publicQuoteUrl: expect.stringContaining("https://app.example.test/q/"),
          fromName: "Acme via YAIP",
          fromEmail: "billing@example.com",
          replyTo: "billing@acme.com",
        }),
        expect.objectContaining({ idempotencyScope: expect.stringMatching(/^quote-(send|resend):/) })
      )
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("uses a verified branded sender for quote email delivery", async () => {
    const previous = {
      YAIP_APP_ORIGIN: process.env.YAIP_APP_ORIGIN,
      YAIP_PUBLIC_QUOTE_SECRET: process.env.YAIP_PUBLIC_QUOTE_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.YAIP_APP_ORIGIN = "https://app.example.test"
    process.env.YAIP_PUBLIC_QUOTE_SECRET = "public-quote-secret-123456"
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@yaip.app"

    const { orgId, caller, quote } = await createQuoteFixture({
      documentSendingDomain: "billing.acme.com",
      documentSendingDomainStatus: "verified",
    })

    try {
      await caller.quotes.send({ id: quote.id })

      expect(sendQuoteEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          fromName: "Acme",
          fromEmail: "billing@billing.acme.com",
          replyTo: "billing@acme.com",
        }),
        expect.objectContaining({ idempotencyScope: expect.stringMatching(/^quote-(send|resend):/) })
      )
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("rejects send when email delivery is not configured unless degraded send is explicitly allowed", async () => {
    const previous = {
      YAIP_APP_ORIGIN: process.env.YAIP_APP_ORIGIN,
      YAIP_PUBLIC_QUOTE_SECRET: process.env.YAIP_PUBLIC_QUOTE_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.YAIP_APP_ORIGIN = "https://app.example.test"
    process.env.YAIP_PUBLIC_QUOTE_SECRET = "public-quote-secret-123456"
    delete process.env.RESEND_API_KEY
    delete process.env.FROM_EMAIL

    const { orgId, caller, quote } = await createQuoteFixture()

    try {
      await expect(caller.quotes.send({ id: quote.id })).rejects.toThrow(
        "Email delivery is not configured"
      )

      const draft = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
        select: {
          status: true,
          publicAccessIssuedAt: true,
          lastEmailAttemptAt: true,
        },
      })

      expect(draft.status).toBe("draft")
      expect(draft.publicAccessIssuedAt).toBeNull()
      expect(draft.lastEmailAttemptAt).toBeNull()

      const degraded = await caller.quotes.send({
        id: quote.id,
        allowSendWithoutEmail: true,
      })

      expect(degraded.emailSent).toBe(false)
      expect(degraded.emailSkipReason).toBe("Email delivery is not configured")

      const reloaded = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
        select: {
          status: true,
          publicAccessIssuedAt: true,
          lastEmailAttemptOutcome: true,
          lastEmailAttemptCode: true,
        },
      })

      expect(reloaded.status).toBe("sent")
      expect(reloaded.publicAccessIssuedAt).toBeTruthy()
      expect(reloaded.lastEmailAttemptOutcome).toBe("skipped")
      expect(reloaded.lastEmailAttemptCode).toBe("provider_missing")
      expect(sendQuoteEmail).not.toHaveBeenCalled()
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("records a failed attempt and keeps the quote in draft when provider delivery throws", async () => {
    const previous = {
      YAIP_APP_ORIGIN: process.env.YAIP_APP_ORIGIN,
      YAIP_PUBLIC_QUOTE_SECRET: process.env.YAIP_PUBLIC_QUOTE_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.YAIP_APP_ORIGIN = "https://app.example.test"
    process.env.YAIP_PUBLIC_QUOTE_SECRET = "public-quote-secret-123456"
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"
    vi.mocked(sendQuoteEmail).mockRejectedValueOnce(new Error("send failed"))

    const { orgId, caller, quote } = await createQuoteFixture()

    try {
      await expect(caller.quotes.send({ id: quote.id })).rejects.toThrow(
        "Failed to send quote email. Quote was not marked as sent."
      )

      const reloaded = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
        select: {
          status: true,
          publicAccessIssuedAt: true,
          lastEmailAttemptOutcome: true,
          lastEmailAttemptCode: true,
        },
      })

      expect(reloaded.status).toBe("draft")
      expect(reloaded.publicAccessIssuedAt).toBeNull()
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
      YAIP_PUBLIC_QUOTE_SECRET: process.env.YAIP_PUBLIC_QUOTE_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.YAIP_APP_ORIGIN = "https://app.example.test"
    process.env.YAIP_PUBLIC_QUOTE_SECRET = "public-quote-secret-123456"
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"

    const { orgId, caller, quote } = await createQuoteFixture({ contactEmail: null })

    try {
      await expect(caller.quotes.send({ id: quote.id })).rejects.toThrow(
        "Contact has no email address"
      )

      const reloaded = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
        select: {
          status: true,
          publicAccessIssuedAt: true,
          lastEmailAttemptAt: true,
        },
      })

      expect(reloaded.status).toBe("draft")
      expect(reloaded.publicAccessIssuedAt).toBeNull()
      expect(reloaded.lastEmailAttemptAt).toBeNull()
      expect(sendQuoteEmail).not.toHaveBeenCalled()
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  it("resends email for a sent quote without rotating the public link", async () => {
    const previous = {
      YAIP_APP_ORIGIN: process.env.YAIP_APP_ORIGIN,
      YAIP_PUBLIC_QUOTE_SECRET: process.env.YAIP_PUBLIC_QUOTE_SECRET,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      FROM_EMAIL: process.env.FROM_EMAIL,
    }

    process.env.YAIP_APP_ORIGIN = "https://app.example.test"
    process.env.YAIP_PUBLIC_QUOTE_SECRET = "public-quote-secret-123456"
    process.env.RESEND_API_KEY = "resend_test_key"
    process.env.FROM_EMAIL = "billing@example.com"

    const { orgId, caller, quote } = await createQuoteFixture()

    try {
      await caller.quotes.send({ id: quote.id })
      const firstCall = vi.mocked(sendQuoteEmail).mock.calls[0]?.[0]

      vi.mocked(sendQuoteEmail).mockClear()

      const resend = await caller.quotes.resendEmail({ id: quote.id })
      expect(resend.emailSent).toBe(true)

      const reloaded = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
        select: {
          status: true,
          publicAccessIssuedAt: true,
          lastEmailAttemptOutcome: true,
        },
      })

      const secondCall = vi.mocked(sendQuoteEmail).mock.calls[0]?.[0]

      expect(reloaded.status).toBe("sent")
      expect(reloaded.publicAccessIssuedAt).toBeTruthy()
      expect(reloaded.lastEmailAttemptOutcome).toBe("sent")
      expect(secondCall?.publicQuoteUrl).toBe(firstCall?.publicQuoteUrl)
    } finally {
      restoreEnv(previous)
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })
})
