import { cleanupTestOrganizations } from "../../../test-utils/organization"
import { randomUUID } from "node:crypto"
import { prisma } from "../../../lib/db"
import { decidePublicQuoteByToken } from "../../../lib/quotes/public-access"
import { signQuotePublicToken } from "../../../lib/quotes/public"
import { appRouter } from "../../router"
import { ensureTestMembership } from "../../../test-utils/membership"

export type InvoiceQuoteSmokeResult = {
  orgId: string
  quote: {
    createdId: string
    updatedTotal: number
    sendBlockedWithoutTaxId: boolean
    sendBlockedMessage?: string
    sentStatus: string
    convertInvoiceId: string
  }
  convertedInvoice: {
    id: string
    updatedTotal: number
    sentStatus: string
    emailSent: boolean
    emailSkipReason?: string
  }
  directInvoice: {
    id: string
    updatedTotal: number
    sentStatus: string
    emailSent: boolean
    emailSkipReason?: string
  }
}

export type InvoiceQuoteSmokeOptions = {
  countryCode: string
  locale: string
  timezone: string
  currency: string
  taxRegime: "us_sales_tax" | "eu_vat"
  pricesIncludeTax: boolean
}

const defaultOptions: InvoiceQuoteSmokeOptions = {
  countryCode: "DK",
  locale: "da-DK",
  timezone: "Europe/Copenhagen",
  currency: "DKK",
  taxRegime: "eu_vat",
  pricesIncludeTax: false,
}

const PUBLIC_QUOTE_TEST_SECRET = "test-public-quote-secret"

export async function runInvoiceQuoteSmokeFlow(
  options?: Partial<InvoiceQuoteSmokeOptions>
): Promise<InvoiceQuoteSmokeResult> {
  const config = { ...defaultOptions, ...options }
  const orgId = randomUUID()
  const slug = `smoke-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
  const previousQuoteSecret = process.env.QUITS_PUBLIC_QUOTE_SECRET

  const ctx = {
    session: {
      user: {
        id: "smoke-user",
        email: "smoke@example.com",
        name: "Smoke User",
      },
      session: {
        activeOrganizationId: orgId,
      },
    },
  }

  const caller = appRouter.createCaller(ctx as never)

  try {
    process.env.QUITS_PUBLIC_QUOTE_SECRET = PUBLIC_QUOTE_TEST_SECRET

    await prisma.organization.create({
      data: {
        id: orgId,
        name: "Smoke Org",
        slug,
        createdAt: new Date(),
        subscriptionStatus: "pro",
      },
    })
    await ensureTestMembership(orgId, "smoke-user")

    await prisma.orgSettings.create({
      data: {
        organizationId: orgId,
        countryCode: config.countryCode,
        locale: config.locale,
        timezone: config.timezone,
        defaultCurrency: config.currency,
        baseCurrency: config.currency,
        currency: config.currency,
        taxRegime: config.taxRegime,
        pricesIncludeTax: config.pricesIncludeTax,
        invoicePrefix: "INVSMK",
        quotePrefix: "QTSMK",
      },
    })

    const contact = await prisma.contact.create({
      data: {
        organizationId: orgId,
        name: "Smoke Buyer",
        email: "buyer@example.com",
        company: "Buyer ApS",
        country: config.countryCode,
      },
    })

    const quoteCreate = await caller.quotes.create({
      contactId: contact.id,
      expiryDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      taxRate: 25,
      items: [
        { description: "Consulting", quantity: 2, unitPrice: 1000 },
        { description: "Support", quantity: 1, unitPrice: 500 },
      ],
    })

    const quoteUpdate = await caller.quotes.update({
      id: quoteCreate.id,
      taxRate: 20,
      items: [{ description: "Consulting", quantity: 3, unitPrice: 900 }],
      notes: "Updated quote",
    })

    let sendBlockedWithoutTaxId = false
    let sendBlockedMessage: string | undefined
    let quoteSent:
      | Awaited<ReturnType<typeof caller.quotes.send>>
      | undefined

    try {
      quoteSent = await caller.quotes.send({
        id: quoteCreate.id,
        allowSendWithoutEmail: true,
      })
    } catch (error) {
      sendBlockedWithoutTaxId = true
      sendBlockedMessage = error instanceof Error ? error.message : String(error)
    }

    if (!quoteSent) {
      await prisma.organizationTaxId.create({
        data: {
          organizationId: orgId,
          scheme: config.countryCode === "DK" ? "DK_CVR" : "VAT",
          value: config.countryCode === "DK" ? "12345678" : "DE123456789",
          countryCode: config.countryCode,
          isPrimary: true,
        },
      })

      quoteSent = await caller.quotes.send({
        id: quoteCreate.id,
        allowSendWithoutEmail: true,
      })
    }

    const token = signQuotePublicToken(
      {
        quoteId: quoteCreate.id,
        keyVersion: quoteSent.publicAccessKeyVersion ?? 1,
        scope: "quote_public",
      },
      PUBLIC_QUOTE_TEST_SECRET
    )

    await decidePublicQuoteByToken(token, PUBLIC_QUOTE_TEST_SECRET, {
      decision: "accepted",
    })

    const convertedInvoice = await caller.quotes.convertToInvoice({ id: quoteCreate.id })

    const convertedInvoiceUpdated = await caller.invoices.update({
      id: convertedInvoice.id,
      taxRate: 22,
      items: [{ description: "Converted line", quantity: 2, unitPrice: 800 }],
      notes: "Converted invoice updated",
    })

    const convertedInvoiceSent = await caller.invoices.send({
      supplyDate: new Date().toISOString().slice(0, 10),
      id: convertedInvoice.id,
      allowSendWithoutEmail: true,
    })

    const directInvoice = await caller.invoices.create({
      contactId: contact.id,
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      taxRate: 25,
      items: [{ description: "Direct invoice", quantity: 4, unitPrice: 250 }],
    })

    const directInvoiceUpdated = await caller.invoices.update({
      id: directInvoice.id,
      taxRate: 10,
      items: [{ description: "Direct invoice", quantity: 5, unitPrice: 200 }],
      notes: "Updated direct invoice",
    })

    const directInvoiceSent = await caller.invoices.send({
      id: directInvoice.id,
      allowSendWithoutEmail: true,
    })

    return {
      orgId,
      quote: {
        createdId: quoteCreate.id,
        updatedTotal: quoteUpdate.total,
        sendBlockedWithoutTaxId,
        sendBlockedMessage,
        sentStatus: quoteSent.status,
        convertInvoiceId: convertedInvoice.id,
      },
      convertedInvoice: {
        id: convertedInvoice.id,
        updatedTotal: convertedInvoiceUpdated.total,
        sentStatus: convertedInvoiceSent.status,
        emailSent: convertedInvoiceSent.emailSent,
        emailSkipReason: convertedInvoiceSent.emailSkipReason,
      },
      directInvoice: {
        id: directInvoice.id,
        updatedTotal: directInvoiceUpdated.total,
        sentStatus: directInvoiceSent.status,
        emailSent: directInvoiceSent.emailSent,
        emailSkipReason: directInvoiceSent.emailSkipReason,
      },
    }
  } finally {
    process.env.QUITS_PUBLIC_QUOTE_SECRET = previousQuoteSecret
    await cleanupTestOrganizations({ where: { id: orgId } })
  }
}
