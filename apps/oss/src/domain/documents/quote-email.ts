import { buildQuoteEmailContent, composeMessage } from "../../lib/email"
import { documentEmailOrg, resolveInvoiceEmailContext } from "./invoice-email"
import { lineAmounts, priceBasis } from "../../lib/documents/line-amounts"

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
  currency: string
  notes: string | null
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
    lineGross: Decimalish
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
  const { envelope } = resolveQuoteEmailContext(input.settings)
  const { quote } = input
  const content = buildQuoteEmailContent({
    fromName: envelope.fromName,
    fromEmail: envelope.fromEmail,
    replyTo: envelope.replyTo,
    quote: {
      ...quote,
      subtotal: quote.subtotalNet.toNumber(),
      taxAmount: quote.totalTax.toNumber(),
      total: quote.totalGross.toNumber(),
      priceBasis: priceBasis(quote.pricesIncludeTax),
      items: quote.items.map((item) => {
        const shown = lineAmounts(priceBasis(quote.pricesIncludeTax), item)
        return {
          description: item.description,
          quantity: item.quantity.toNumber(),
          unitPrice: shown.unitPrice.toNumber(),
          total: shown.amount.toNumber(),
        }
      }),
    },
    org: documentEmailOrg(quote, input.settings),
    contactName: quote.contact.name,
    publicQuoteUrl: input.publicQuoteUrl,
  })
  return { message: composeMessage(input.to, content), usingBrandedDomain: envelope.usingBrandedDomain }
}
