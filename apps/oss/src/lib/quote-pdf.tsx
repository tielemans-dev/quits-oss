import { parseBuyerSnapshot, parseSellerSnapshot } from "@quits/contracts/documents"
import type { Prisma } from "../../generated/prisma/client"
import { buildBuyerSnapshot } from "../domain/documents/snapshots"
import { documentVatSummary } from "../domain/documents/vat-summary"
import { lineAmounts, nominalLineTaxRate, priceBasis } from "./documents/line-amounts"
import { InvoicePdfDocument, type InvoiceForPdf } from "./invoice-pdf"
import { getDocumentRenderer } from "./runtime/services"
import { renderPdf } from "./documents/render-pdf"

type QuoteForPdf = Prisma.QuoteGetPayload<{ include: {
  contact: { include: { taxIds: true } }
  items: true
  organization: { select: { settings: { select: {
    companyLogo: true; companyName: true; companyEmail: true; companyAddress: true
  } } } }
} }>

/** Persisted quote amounts and identities, presented with the shared invoice layout. */
export function QuotePdfDocument({ quote }: { quote: QuoteForPdf }) {
  return InvoicePdfDocument(quotePdfInput(quote))
}

/** Plain presentation data shared by all host renderers, without Prisma dates or decimals. */
export function quotePdfInput(quote: QuoteForPdf) {
  const seller = parseSellerSnapshot(quote.sellerSnapshot)
  const buyer = parseBuyerSnapshot(quote.buyerSnapshot) ?? buildBuyerSnapshot(quote.contact)
  const settings = quote.organization.settings
  const items = [...quote.items].sort((a, b) => a.sortOrder - b.sortOrder)
  const invoice: InvoiceForPdf = {
    number: quote.number ?? "", status: quote.status,
    issueDate: quote.issueDate.toISOString(), dueDate: quote.expiryDate.toISOString(),
    subtotal: quote.subtotalNet.toNumber(), taxAmount: quote.totalTax.toNumber(), total: quote.totalGross.toNumber(),
    currency: quote.currency, notes: quote.notes, pricesIncludeTax: quote.pricesIncludeTax,
    taxRegime: quote.taxRegime, momsRegistered: seller?.momsRegistered,
    taxRate: nominalLineTaxRate(items.map(item => item.taxRate.toNumber())),
    ...documentVatSummary(quote),
    contact: { ...buyer, name: buyer.name ?? quote.contact.name },
    items: items.map(item => {
      const shown = lineAmounts(priceBasis(quote.pricesIncludeTax), item)
      return { description: item.description, quantity: item.quantity.toNumber(),
        unitPrice: shown.unitPrice.toNumber(), total: shown.amount.toNumber(), taxRate: item.taxRate.toNumber() }
    }),
  }
  return { invoice, quote: { expiryDate: quote.expiryDate.toISOString() }, org: {
    // Branding can change; the seller and buyer identities remain the quote's snapshots.
    companyLogo: settings?.companyLogo,
    companyName: seller ? seller.companyName : settings?.companyName,
    companyEmail: seller ? seller.companyEmail : settings?.companyEmail,
    companyAddress: seller ? seller.companyAddress : settings?.companyAddress,
    taxIds: seller?.taxIds,
    locale: quote.locale, timezone: quote.timezone,
  } }
}

export async function renderQuotePdf(quote: QuoteForPdf) {
  const renderer = getDocumentRenderer()
  if (!renderer) throw new Error("Document renderer unavailable")
  const pdf = quotePdfInput(quote)
  return renderPdf(renderer, {
    kind: "quote", organizationId: quote.organizationId, documentId: quote.id,
    number: quote.number ?? "", issuedAt: quote.issueDate.toISOString(),
    recipient: quote.contact.email?.trim() || null,
    snapshot: { seller: quote.sellerSnapshot, buyer: quote.buyerSnapshot }, pdf,
  })
}
