import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { LocalizedDocument } from "../../components/documents/localized-document"
import { PublicInvoicePaymentPage } from "../../components/invoices/public-invoice-payment-page"
import { invalidLinkLocale } from "../documents/public-invalid-link"
import { signInvoicePaymentToken } from "../payments/public"
import { loadInvalidPublicInvoiceLocale } from "../payments/public-access"

const secret = "pay-invalid-locale-test-secret"
const invoiceId = "inv-pay-invalid"

// MOCK: the stored invoice row and the request headers; token signing and locale resolution are real.
const state = vi.hoisted(() => ({
  invoice: null as null | { locale: string | null; organization: { settings: { locale: string | null } | null } },
  acceptLanguage: undefined as string | undefined,
}))
vi.mock("../db", () => ({
  prisma: { invoice: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === invoiceId ? state.invoice : null) } },
}))
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeader: (name: string) => (name === "accept-language" ? state.acceptLanguage : undefined),
  setResponseHeader: () => undefined,
}))

const token = signInvoicePaymentToken({ invoiceId, keyVersion: 1, scope: "invoice_payment" }, secret)

async function invalidPage(link: string) {
  const locale = invalidLinkLocale(await loadInvalidPublicInvoiceLocale(link, secret))
  return renderToStaticMarkup(<LocalizedDocument locale={locale}><PublicInvoicePaymentPage token={link} state={{ kind: "invalid" }} /></LocalizedDocument>)
}

describe("/pay for a link that no longer opens its invoice", () => {
  beforeEach(() => {
    state.invoice = null
    state.acceptLanguage = "en-US,en;q=0.9"
  })

  it("answers in Danish for a Danish invoice, whatever the visitor's browser prefers", async () => {
    state.invoice = { locale: "da-DK", organization: { settings: { locale: "en-US" } } }

    const html = await invalidPage(token)

    expect(html).toContain('lang="da-DK"')
    expect(html).toContain("Fakturaen er ikke tilgængelig")
    expect(html).toContain("Dette betalingslink er ugyldigt eller udløbet.")
  })

  it("falls back to the Danish seller's language when the invoice has none", async () => {
    state.invoice = { locale: null, organization: { settings: { locale: "da-DK" } } }

    expect(await invalidPage(token)).toContain("Fakturaen er ikke tilgængelig")
  })

  it.each([
    ["da-DK,da;q=0.9", "Fakturaen er ikke tilgængelig"],
    ["en-US,en;q=0.9", "Invoice unavailable"],
  ])("answers a forged link in the visitor's language: %s", async (acceptLanguage, title) => {
    state.acceptLanguage = acceptLanguage

    expect(await invalidPage(`${token}x`)).toContain(title)
  })
})
