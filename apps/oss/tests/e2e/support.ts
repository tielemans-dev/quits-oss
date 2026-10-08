import "dotenv/config"
import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { signInvoicePaymentToken } from "../../src/lib/payments/public"
import { signQuotePublicToken } from "../../src/lib/quotes/public"
import {
  applySetupInitialization,
  completeSetup,
} from "../../src/lib/setup/apply"

process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5432/yaip?schema=public"

export const appOrigin = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000"
export const publicPaymentSecret =
  process.env.QUITS_PUBLIC_PAYMENT_SECRET ?? process.env.YAIP_PUBLIC_PAYMENT_SECRET ?? "payment-link-e2e-secret-123456"
export const publicQuoteSecret =
  process.env.QUITS_PUBLIC_QUOTE_SECRET ?? process.env.YAIP_PUBLIC_QUOTE_SECRET ?? "quote-link-e2e-secret-123456"
export const adminCredentials = {
  email: "admin@e2e.example",
  name: "E2E Admin",
  password: "SuperSecure123!",
}

type PublicSeed = {
  id: string
  number: string
  url: string
}

type SeedLocale = {
  locale: string
  countryCode: string
  timezone: string
  currency: string
}

/** The default seller: a US English organization that bills in dollars. */
export const usEnglishLocale: SeedLocale = {
  locale: "en-US",
  countryCode: "US",
  timezone: "UTC",
  currency: "USD",
}

/** A Danish seller: the organization and the documents it issues are Danish and bill in kroner. */
export const danishLocale: SeedLocale = {
  locale: "da-DK",
  countryCode: "DK",
  timezone: "Europe/Copenhagen",
  currency: "DKK",
}

/** A 1x1 transparent PNG, to stand in for an uploaded company logo. */
export const tinyLogoDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

export type PublicSeedOptions = {
  /** Language, country, timezone and currency of the seller and of the document. */
  locale?: SeedLocale
  /** Stored on the seller's settings and shown at the top of the page. */
  companyLogo?: string
  /** The document total, with two decimals. Defaults to 100.00 for a quote and 250.00 for an invoice. */
  total?: string
}

export async function resetDatabase() {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `

  if (tables.length === 0) {
    return
  }

  const names = tables
    .map(({ tablename }) => `"public"."${tablename}"`)
    .join(", ")

  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`)
}

export async function seedCompletedSetup(locale: SeedLocale = usEnglishLocale) {
  const slug = `e2e-${Math.random().toString(36).slice(2, 10)}`
  const initialized = await applySetupInitialization({
    instanceProfile: "smb",
    organization: {
      name: "E2E Org",
      slug,
    },
    admin: adminCredentials,
    auth: {
      mode: "local_only",
    },
    locale,
  })

  await completeSetup()

  return initialized
}

export async function seedPublicQuote(options: PublicSeedOptions = {}): Promise<PublicSeed> {
  const locale = options.locale ?? usEnglishLocale
  const total = options.total ?? "100.00"
  const setup = await seedCompletedSetup(locale)

  if (options.companyLogo) {
    await prisma.orgSettings.update({
      where: { organizationId: setup.organizationId },
      data: { companyLogo: options.companyLogo },
    })
  }

  const contact = await prisma.contact.create({
    data: {
      organizationId: setup.organizationId,
      name: "Quote Customer",
      email: "quote-customer@example.com",
      company: "Quote Customer LLC",
      country: "US",
    },
  })

  const quote = await prisma.quote.create({
    data: {
      organizationId: setup.organizationId,
      contactId: contact.id,
      number: "QTE-E2E-0001",
      status: "sent",
      issueDate: new Date("2026-03-09T00:00:00.000Z"),
      expiryDate: new Date("2026-03-23T00:00:00.000Z"),
      publicAccessIssuedAt: new Date("2026-03-09T00:00:00.000Z"),
      publicAccessKeyVersion: 1,
      subtotalNet: total,
      totalTax: "0.00",
      totalGross: total,
      currency: locale.currency,
      countryCode: locale.countryCode,
      locale: locale.locale,
      timezone: locale.timezone,
      taxRegime: locale.countryCode === "US" ? "us_sales_tax" : "eu_vat",
      pricesIncludeTax: false,
      sellerSnapshot: {
        companyName: "E2E Org",
        companyEmail: adminCredentials.email,
      },
      buyerSnapshot: {
        name: contact.name,
        email: contact.email,
        company: contact.company,
      },
      items: {
        create: [
          {
            description: "Strategy session",
            quantity: "1.00",
            unitPriceNet: total,
            unitPriceGross: total,
            lineNet: total,
            lineTax: "0.00",
            lineGross: total,
            taxRate: "0.00",
            taxCategory: "standard",
            sortOrder: 0,
          },
        ],
      },
    },
  })

  const token = signQuotePublicToken(
    {
      quoteId: quote.id,
      keyVersion: quote.publicAccessKeyVersion,
      scope: "quote_public",
    },
    publicQuoteSecret
  )

  return {
    id: quote.id,
    number: quote.number,
    url: `${appOrigin}/q/${encodeURIComponent(token)}`,
  }
}

export async function seedPublicInvoice(options: PublicSeedOptions = {}): Promise<PublicSeed> {
  const locale = options.locale ?? usEnglishLocale
  const total = options.total ?? "250.00"
  const setup = await seedCompletedSetup(locale)

  await prisma.orgSettings.update({
    where: { organizationId: setup.organizationId },
    data: {
      stripePublishableKey: "pk_test_123456789",
      stripeSecretKeyEnc: "sk_test_placeholder",
      stripeWebhookSecretEnc: "whsec_placeholder",
      ...(options.companyLogo ? { companyLogo: options.companyLogo } : {}),
    },
  })

  const contact = await prisma.contact.create({
    data: {
      organizationId: setup.organizationId,
      name: "Invoice Customer",
      email: "invoice-customer@example.com",
      company: "Invoice Customer LLC",
      country: "US",
    },
  })

  const invoice = await prisma.invoice.create({
    data: {
      organizationId: setup.organizationId,
      contactId: contact.id,
      number: "INV-E2E-0001",
      status: "sent",
      paymentStatus: "unpaid",
      issueDate: new Date("2026-03-09T00:00:00.000Z"),
      dueDate: new Date("2026-03-23T00:00:00.000Z"),
      publicPaymentIssuedAt: new Date("2026-03-09T00:00:00.000Z"),
      publicPaymentKeyVersion: 1,
      subtotalNet: total,
      totalTax: "0.00",
      totalGross: total,
      currency: locale.currency,
      countryCode: locale.countryCode,
      locale: locale.locale,
      timezone: locale.timezone,
      taxRegime: locale.countryCode === "US" ? "us_sales_tax" : "eu_vat",
      pricesIncludeTax: false,
      sellerSnapshot: {
        companyName: "E2E Org",
        companyEmail: adminCredentials.email,
      },
      buyerSnapshot: {
        name: contact.name,
        email: contact.email,
        company: contact.company,
      },
      items: {
        create: [
          {
            description: "Implementation sprint",
            quantity: "1.00",
            unitPriceNet: total,
            unitPriceGross: total,
            lineNet: total,
            lineTax: "0.00",
            lineGross: total,
            taxRate: "0.00",
            taxCategory: "standard",
            sortOrder: 0,
          },
        ],
      },
    },
  })

  const token = signInvoicePaymentToken(
    {
      invoiceId: invoice.id,
      keyVersion: invoice.publicPaymentKeyVersion,
      scope: "invoice_payment",
    },
    publicPaymentSecret
  )

  return {
    id: invoice.id,
    number: invoice.number,
    url: `${appOrigin}/pay/${encodeURIComponent(token)}`,
  }
}

export async function loginAsAdmin(page: Page) {
  await page.goto("/login")
  await waitForClientReady(page)
  await page.getByLabel("Email").fill(adminCredentials.email)
  await page.getByLabel("Password").fill(adminCredentials.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForURL(
    (url) => !url.pathname.startsWith("/login"),
    { timeout: 10_000 }
  )
  await waitForClientReady(page)
}

export function uniqueEmail(prefix: string) {
  return `${prefix}-${randomUUID()}@example.com`
}

export async function waitForClientReady(page: Page) {
  await page.waitForLoadState("networkidle")
  await page.waitForTimeout(250)
}
