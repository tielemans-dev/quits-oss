import "dotenv/config"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { signQuotePublicToken } from "../../../lib/quotes/public"
import { decidePublicQuoteByToken } from "../../../lib/quotes/public-access"
import { appRouter } from "../../router"
import { ensureTestMembership } from "../../../test-utils/membership"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip
const PUBLIC_QUOTE_TEST_SECRET = "test-public-quote-secret"

describeIfDatabase("quote conversion after public acceptance", () => {
  it("requires acceptance before converting a sent quote into an invoice", async () => {
    const orgId = randomUUID()
    const slug = `quote-accept-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
    const previousQuoteSecret = process.env.QUITS_PUBLIC_QUOTE_SECRET

    process.env.QUITS_PUBLIC_QUOTE_SECRET = PUBLIC_QUOTE_TEST_SECRET

    const caller = appRouter.createCaller({
      session: {
        user: {
          id: "quote-accept-user",
          email: "quote-accept@example.com",
          name: "Quote Accept User",
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
          name: "Quote Accept Org",
          slug,
          createdAt: new Date(),
          subscriptionStatus: "pro",
        },
      })
      await ensureTestMembership(orgId, "quote-accept-user")

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
          invoicePrefix: "INVACC",
          quotePrefix: "QTEACC",
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

      const quote = await caller.quotes.create({
        contactId: contact.id,
        expiryDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        taxRate: 25,
        items: [{ description: "Consulting", quantity: 2, unitPrice: 1000 }],
      })

      await caller.quotes.send({ id: quote.id, allowSendWithoutEmail: true })

      await expect(caller.quotes.convertToInvoice({ id: quote.id })).rejects.toThrow(
        "Only accepted quotes can be converted to invoices"
      )

      const token = signQuotePublicToken(
        {
          quoteId: quote.id,
          keyVersion: 1,
          scope: "quote_public",
        },
        PUBLIC_QUOTE_TEST_SECRET
      )

      await decidePublicQuoteByToken(token, PUBLIC_QUOTE_TEST_SECRET, {
        decision: "accepted",
      })

      const invoice = await caller.quotes.convertToInvoice({ id: quote.id })

      expect(invoice.quoteId).toBe(quote.id)
    } finally {
      process.env.QUITS_PUBLIC_QUOTE_SECRET = previousQuoteSecret
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })
})
