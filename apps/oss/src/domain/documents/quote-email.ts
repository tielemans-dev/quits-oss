import { parseSellerSnapshot } from "@quits/contracts/documents"
import { buildQuoteEmailContent, composeMessage } from "../../lib/email"
import { documentEmailOrg, resolveInvoiceEmailContext } from "./invoice-email"
import { lineAmounts, priceBasis } from "../../lib/documents/line-amounts"
import { documentVatSummary } from "./vat-summary"

export { requireRecipientEmail } from "./invoice-email"

type Decimalish = { toNumber(): number }

type OrgEmailSettings = Parameters<typeof resolveInvoiceEmailContext>[0]

export type QuoteForEmail = {
  id: string
  number: string
  /** Copied from the organization when the draft was created. Required so no caller can drop them. */
  locale: string
  timezone: string
  issueDate: Date
  expiryDate: Date
  taxRegime?: string
  currency: string
  notes: string | null
  sellerSnapshot?: unknown
  subtotalNet: Decimalish
  totalTax: Decimalish
  totalGross: Decimalish
  pricesIncludeTax: boolean
  contact: { name: string; email: string | null }
  items: Array<{
    description: string
    quantity: Decimalish
    unitPriceNet: Decimalish
    unitPriceGross: Decimalish
    lineNet: Decimalish
    lineTax: Decimalish
    lineGross: Decimalish
    taxRate: Decimalish
    vatTreatment: string
    vatReasonCode: string | null
    vatCountry: string | null
    vatRateInput: string | null
  }>
}

/** Sender identity and whether email delivery is available. Quotes carry no pay link. */
export function resolveQuoteEmailContext(settings: OrgEmailSettings) {
  const { envelope, emailDelivery } = resolveInvoiceEmailContext(settings)
  return { envelope, emailDelivery }
}

/** The quote email exactly as it will be delivered. */
export function composeQuoteEmail(input: {
  quote: QuoteForEmail
  settings: OrgEmailSettings
  to: string
  publicQuoteUrl: string | null
}) {
  const { quote } = input
  const seller = parseSellerSnapshot(quote.sellerSnapshot)
  const { envelope } = resolveQuoteEmailContext(input.settings)
  const vatSummary = documentVatSummary(quote)
  const content = buildQuoteEmailContent({
    fromName: envelope.fromName,
    fromEmail: envelope.fromEmail,
    replyTo: envelope.replyTo,
    quote: {
      ...quote,
      momsRegistered: seller?.momsRegistered,
      subtotal: quote.subtotalNet.toNumber(),
      taxAmount: quote.totalTax.toNumber(),
      total: quote.totalGross.toNumber(),
      priceBasis: priceBasis(quote.pricesIncludeTax),
      ...vatSummary,
      items: quote.items.map((item) => {
        const shown = lineAmounts(priceBasis(quote.pricesIncludeTax), item)
        return {
          description: item.description,
          taxRate: item.taxRate.toNumber(),
          quantity: item.quantity.toNumber(),
          unitPrice: shown.unitPrice.toNumber(),
          total: shown.amount.toNumber(),
        }
      }),
    },
    org: { ...documentEmailOrg(quote, input.settings),
      ...(seller ? { companyName: seller.companyName, companyEmail: seller.companyEmail } : {}),
    },
    contactName: quote.contact.name,
    publicQuoteUrl: input.publicQuoteUrl,
  })
  return { message: composeMessage(input.to, content), usingBrandedDomain: envelope.usingBrandedDomain }
}
