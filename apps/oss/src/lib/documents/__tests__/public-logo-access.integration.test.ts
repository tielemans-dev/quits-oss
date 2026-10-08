import "dotenv/config"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { executeIssuanceCommand } from "../../../application/issuance"
import { createAgreementDraft } from "../../../domain/commands/agreements"
import { issueAgreement } from "../../../domain/commands/agreement-lifecycle"
import { createContact } from "../../../domain/commands/contacts"
import { createInvoiceDraft, sendInvoice } from "../../../domain/commands/invoices"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { mintAgreementLink, signAgreementPublicToken } from "../../agreements/tokens"
import { prisma } from "../../db"
import { signInvoicePaymentToken } from "../../payments/public"
import { signQuotePublicToken } from "../../quotes/public"
import { publicAgreementLogo, publicInvoiceLogo, publicQuoteLogo } from "../public-logo-access"

// A 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

const paymentSecret = "payment-link-secret-logo-123456"
const quoteSecret = "quote-link-secret-logo-123456789"
const agreementSecret = "agreement-link-secret-logo-0123456789"

async function expectLogo(response: Response) {
  expect(response.status).toBe(200)
  expect(response.headers.get("Content-Type")).toBe("image/png")
  expect(response.headers.get("Cache-Control")).toBe("private, max-age=300")
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
  expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(PNG_BASE64)
}

;(hasTestDatabase ? describe : describe.skip)("public logo routes", () => {
  const cleanups: Array<() => Promise<void>> = []
  const previous = {
    payment: process.env.QUITS_PUBLIC_PAYMENT_SECRET,
    quote: process.env.QUITS_PUBLIC_QUOTE_SECRET,
    agreement: process.env.QUITS_PUBLIC_AGREEMENT_SECRET,
  }

  beforeEach(() => {
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = paymentSecret
    process.env.QUITS_PUBLIC_QUOTE_SECRET = quoteSecret
    process.env.QUITS_PUBLIC_AGREEMENT_SECRET = agreementSecret
  })

  afterEach(async () => {
    process.env.QUITS_PUBLIC_PAYMENT_SECRET = previous.payment
    process.env.QUITS_PUBLIC_QUOTE_SECRET = previous.quote
    process.env.QUITS_PUBLIC_AGREEMENT_SECRET = previous.agreement
    vi.useRealTimers()
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function organization(companyLogo: string | null) {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    await prisma.orgSettings.update({
      where: { organizationId: org.organizationId },
      data: { companyLogo },
    })
    const contact = await executeIssuanceCommand(
      createContact,
      { name: "Buyer", email: "buyer@example.test" },
      { actor: org.actors.admin }
    )
    if (contact.status !== "completed") throw new Error("contact setup failed")
    return { org, contactId: contact.result.id }
  }

  describe("invoice", () => {
    async function sentInvoice(companyLogo: string | null) {
      const { org, contactId } = await organization(companyLogo)
      const draft = await executeIssuanceCommand(
        createInvoiceDraft,
        {
          contactId,
          dueDate: "2099-12-01",
          currency: "USD",
          taxRate: 0,
          items: [{ description: "Consulting", quantity: 1, unitPrice: 100 }],
        },
        { actor: org.actors.admin }
      )
      if (draft.status !== "completed") throw new Error("draft failed")
      const sent = await executeIssuanceCommand(
        sendInvoice,
        { id: draft.result.id, allowSendWithoutEmail: true },
        { actor: org.actors.admin }
      )
      if (sent.status !== "completed") throw new Error("send failed")
      const invoice = await prisma.invoice.update({
        where: { id: draft.result.id },
        data: { publicPaymentIssuedAt: new Date() },
      })
      const token = (keyVersion = invoice.publicPaymentKeyVersion) =>
        signInvoicePaymentToken(
          { invoiceId: invoice.id, keyVersion, scope: "invoice_payment" },
          paymentSecret
        )
      return { invoice, token }
    }

    it("serves the uploaded logo for a valid link", async () => {
      const { token } = await sentInvoice(PNG_DATA_URL)
      await expectLogo(await publicInvoiceLogo(token()))
    })

    it("answers 404 for a link that does not open the page", async () => {
      const { invoice, token } = await sentInvoice(PNG_DATA_URL)

      expect((await publicInvoiceLogo("not-a-token")).status).toBe(404)
      expect(
        (await publicInvoiceLogo(token(invoice.publicPaymentKeyVersion + 1))).status
      ).toBe(404)
      // The same link the page refuses once the invoice is back to a draft.
      await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "draft" } })
      expect((await publicInvoiceLogo(token())).status).toBe(404)
    })

    it("answers 404 without a logo, or with one that is not an uploaded image", async () => {
      expect((await publicInvoiceLogo((await sentInvoice(null)).token())).status).toBe(404)
      // An http(s) logo is shown from its own address; the server never fetches it.
      expect(
        (await publicInvoiceLogo((await sentInvoice("https://acme.example/logo.png")).token())).status
      ).toBe(404)
    })
  })

  describe("quote", () => {
    async function sentQuote(companyLogo: string | null) {
      const { org, contactId } = await organization(companyLogo)
      const quote = await prisma.quote.create({
        data: {
          organizationId: org.organizationId,
          contactId,
          number: "QTE-0001",
          status: "sent",
          publicAccessIssuedAt: new Date(),
          expiryDate: new Date("2099-03-20T00:00:00.000Z"),
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
      const token = (keyVersion = quote.publicAccessKeyVersion) =>
        signQuotePublicToken({ quoteId: quote.id, keyVersion, scope: "quote_public" }, quoteSecret)
      return { quote, token }
    }

    it("serves the uploaded logo for a valid link", async () => {
      const { token } = await sentQuote(PNG_DATA_URL)
      await expectLogo(await publicQuoteLogo(token()))
    })

    it("answers 404 for a link that does not open the page", async () => {
      const { quote, token } = await sentQuote(PNG_DATA_URL)

      expect((await publicQuoteLogo("not-a-token")).status).toBe(404)
      expect((await publicQuoteLogo(token(quote.publicAccessKeyVersion + 1))).status).toBe(404)
      await prisma.quote.update({ where: { id: quote.id }, data: { status: "draft" } })
      expect((await publicQuoteLogo(token())).status).toBe(404)
    })

    it("answers 404 without a logo", async () => {
      expect((await publicQuoteLogo((await sentQuote(null)).token())).status).toBe(404)
    })
  })

  describe("agreement", () => {
    async function issuedAgreement(companyLogo: string | null) {
      const { org, contactId } = await organization(companyLogo)
      const draft = await executeIssuanceCommand(
        createAgreementDraft,
        {
          contactId,
          title: "Website",
          validUntil: "2099-01-01",
          termsMarkdown: "Terms",
          deliverables: [{ title: "Work", quantity: 1, unitPrice: 100 }],
        },
        { actor: org.actors.admin }
      )
      if (draft.status !== "completed") throw new Error("draft failed")
      const issued = await executeIssuanceCommand(
        issueAgreement,
        { id: draft.result.id },
        { actor: org.actors.admin }
      )
      if (issued.status !== "completed") throw new Error("issue failed")
      return issued.result
    }

    it("serves the uploaded logo for a valid link", async () => {
      const agreement = await issuedAgreement(PNG_DATA_URL)
      await expectLogo(await publicAgreementLogo(mintAgreementLink(agreement, "decide", new Date()).token))
    })

    it("keeps serving it once the link can no longer be used to decide", async () => {
      const agreement = await issuedAgreement(PNG_DATA_URL)
      const { token } = mintAgreementLink(agreement, "decide", new Date())
      await prisma.agreement.update({ where: { id: agreement.id }, data: { status: "declined" } })

      await expectLogo(await publicAgreementLogo(token))
    })

    it("answers 404 for a forged, expired or revoked link", async () => {
      const agreement = await issuedAgreement(PNG_DATA_URL)
      const { token } = mintAgreementLink(agreement, "decide", new Date())

      expect((await publicAgreementLogo("not-a-token")).status).toBe(404)
      expect((await publicAgreementLogo(`${token}x`)).status).toBe(404)

      const expired = signAgreementPublicToken(
        {
          agreementId: agreement.id,
          keyVersion: agreement.publicAccessKeyVersion,
          scope: "decide",
          offerRevision: agreement.offerRevision,
          exp: new Date(Date.now() - 1000).toISOString(),
        },
        agreementSecret
      )
      expect((await publicAgreementLogo(expired)).status).toBe(404)

      await prisma.agreement.update({
        where: { id: agreement.id },
        data: { publicAccessKeyVersion: { increment: 1 } },
      })
      expect((await publicAgreementLogo(token)).status).toBe(404)
    })

    it("answers 404 without a logo", async () => {
      const agreement = await issuedAgreement(null)
      expect(
        (await publicAgreementLogo(mintAgreementLink(agreement, "decide", new Date()).token)).status
      ).toBe(404)
    })
  })
})
