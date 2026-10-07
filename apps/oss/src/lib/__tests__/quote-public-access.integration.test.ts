import { cleanupTestOrganizations } from "../../test-utils/organization"
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../db"
import { signQuotePublicToken } from "../quotes/public"
import {
  decidePublicQuoteByToken,
  loadPublicQuoteByToken,
} from "../quotes/public-access"

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL)
const describeIfDatabase = hasDatabaseUrl ? describe : describe.skip
const secret = "quote-public-test-secret"

async function seedPublicQuote() {
  const orgId = randomUUID()
  const contactId = randomUUID()
  const slug = `quote-public-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`

  await prisma.organization.create({
    data: {
      id: orgId,
      name: "Public Quote Org",
      slug,
      createdAt: new Date(),
      subscriptionStatus: "pro",
    },
  })

  await prisma.contact.create({
    data: {
      id: contactId,
      organizationId: orgId,
      name: "Public Quote Contact",
      email: "customer@example.com",
    },
  })

  const quote = await prisma.quote.create({
    data: {
      organizationId: orgId,
      contactId,
      number: "QTE-0001",
      status: "sent",
      publicAccessIssuedAt: new Date("2026-03-05T00:00:00.000Z"),
      expiryDate: new Date("2026-03-20T00:00:00.000Z"),
      subtotalNet: "100.00",
      totalTax: "0.00",
      totalGross: "100.00",
      currency: "USD",
      countryCode: "US",
      locale: "en-US",
      timezone: "UTC",
      taxRegime: "us_sales_tax",
      pricesIncludeTax: false,
      items: {
        create: [
          {
            description: "Consulting",
            quantity: "1.00",
            unitPriceNet: "100.00",
            unitPriceGross: "100.00",
            lineNet: "100.00",
            lineTax: "0.00",
            lineGross: "100.00",
            taxRate: "0.00",
            taxCategory: "standard",
            sortOrder: 0,
          },
        ],
      },
    },
    select: {
      id: true,
      organizationId: true,
    },
  })

  return quote
}

describeIfDatabase("quote public access", () => {
  afterEach(async () => {
    await cleanupTestOrganizations({
      where: {
        name: "Public Quote Org",
      },
    })
  })

  it("loads a sent quote from a valid public token and returns pending decision state", async () => {
    const quote = await seedPublicQuote()
    const token = signQuotePublicToken(
      {
        quoteId: quote.id,
        keyVersion: 1,
        scope: "quote_public",
      },
      secret
    )

    const loaded = await loadPublicQuoteByToken(token, secret)

    expect(loaded?.quote.id).toBe(quote.id)
    expect(loaded?.decisionState).toBe("pending")
  })

  it("does not expose draft quotes even with a valid signed token", async () => {
    const quote = await seedPublicQuote()
    await prisma.quote.update({
      where: { id: quote.id },
      data: {
        status: "draft",
      },
    })

    const token = signQuotePublicToken(
      {
        quoteId: quote.id,
        keyVersion: 1,
        scope: "quote_public",
      },
      secret
    )

    const loaded = await loadPublicQuoteByToken(token, secret)

    expect(loaded).toBeNull()
  })

  it("rejects invalid public tokens", async () => {
    const loaded = await loadPublicQuoteByToken("bad.token", secret)
    expect(loaded).toBeNull()
  })

  it("accepts a public quote once and leaves the link read-only afterward", async () => {
    const quote = await seedPublicQuote()
    const token = signQuotePublicToken(
      {
        quoteId: quote.id,
        keyVersion: 1,
        scope: "quote_public",
      },
      secret
    )

    const accepted = await decidePublicQuoteByToken(token, secret, {
      decision: "accepted",
    })

    expect(accepted.quote.status).toBe("accepted")
    expect(accepted.decisionState).toBe("accepted")

    await expect(
      decidePublicQuoteByToken(token, secret, {
        decision: "rejected",
        rejectionReason: "Too expensive",
      })
    ).rejects.toThrow(/already has a customer decision/i)

    const loaded = await loadPublicQuoteByToken(token, secret)
    expect(loaded?.decisionState).toBe("accepted")
  })
})
