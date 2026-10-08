import { buildQuoteEmailContent, composeMessage } from "../../lib/email"
import { documentEmailOrg, resolveInvoiceEmailContext } from "./invoice-email"

export { requireRecipientEmail } from "./invoice-email"

type Decimalish = { toNumber(): number }

type OrgEmailSettings = Parameters<typeof resolveInvoiceEmailContext>[0]

export type QuoteForEmail = {
  id: string
  number: string
  /** Copied from the organization when the draft was created; legacy rows may lack them. */
  locale?: string | null
  timezone?: string | null
  issueDate: Date
  expiryDate: Date
  currency: string
  notes: string | null
  subtotalNet: Decimalish
  totalTax: Decimalish
  totalGross: Decimalish
  contact: { name: string; email: string | null }
  items: Array<{
    description: string
    quantity: Decimalish
    unitPriceGross: Decimalish
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
      items: quote.items.map((item) => ({
        description: item.description,
        quantity: item.quantity.toNumber(),
        unitPrice: item.unitPriceGross.toNumber(),
        total: item.lineGross.toNumber(),
      })),
    },
    org: documentEmailOrg(quote, input.settings),
    contactName: quote.contact.name,
    publicQuoteUrl: input.publicQuoteUrl,
  })
  return { message: composeMessage(input.to, content), usingBrandedDomain: envelope.usingBrandedDomain }
}
