import { logoNotFound, logoResponse } from "./public-logo"

/**
 * The logo routes of the pages opened from a link. Each checks the link exactly as the page does,
 * so a link that no longer opens the page does not serve the seller's logo either.
 */

export async function publicInvoiceLogo(token: string) {
  const [{ loadPublicInvoiceByToken }, { getPublicInvoicePaymentSecret }] = await Promise.all([
    import("../payments/public-access"),
    import("../payments/public"),
  ])
  const session = await loadPublicInvoiceByToken(token, getPublicInvoicePaymentSecret())
  if (!session) return logoNotFound()
  return logoResponse(session.invoice.organization.settings?.companyLogo)
}

export async function publicQuoteLogo(token: string) {
  const [{ loadPublicQuoteByToken }, { getPublicQuoteSecret }] = await Promise.all([
    import("../quotes/public-access"),
    import("../quotes/public-url"),
  ])
  const session = await loadPublicQuoteByToken(token, getPublicQuoteSecret())
  if (!session) return logoNotFound()
  return logoResponse(session.quote.organization.settings?.companyLogo)
}

export async function publicAgreementLogo(token: string) {
  const { loadPublicAgreementLogoByToken } = await import("../agreements/public-access")
  const session = await loadPublicAgreementLogoByToken(token)
  if (!session) return logoNotFound()
  return logoResponse(session.companyLogo)
}
