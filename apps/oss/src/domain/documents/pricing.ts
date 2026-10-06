import type { DocumentLineInput } from "@yaip/contracts/invoices"
import { computeDocumentTotals, type CountryProfile } from "../../lib/compliance"
import { currencyFractionDigits } from "../../lib/payments/stripe-amounts"

/** Document amounts are stored with two decimals, so three-decimal currencies round to two. */
export function documentFractionDigits(currency: string) {
  return Math.min(currencyFractionDigits(currency), 2)
}

/** Prices lines and returns totals plus item rows ready to persist. */
export function priceDocument(input: {
  profile: CountryProfile
  items: DocumentLineInput[]
  taxRate: number
  pricesIncludeTax: boolean
  currency: string
}) {
  const totals = computeDocumentTotals(input.profile, {
    items: input.items,
    taxRate: input.taxRate,
    pricesIncludeTax: input.pricesIncludeTax,
    fractionDigits: documentFractionDigits(input.currency),
  })

  return {
    subtotalNet: totals.subtotalNet,
    totalTax: totals.totalTax,
    totalGross: totals.totalGross,
    itemRows: totals.lines.map((line, index) => ({
      description: line.description,
      quantity: line.quantity,
      unitPriceNet: line.unitPriceNet,
      unitPriceGross: line.unitPriceGross,
      lineNet: line.lineNet,
      lineTax: line.lineTax,
      lineGross: line.lineGross,
      taxRate: line.taxRate,
      taxCategory: "standard",
      sortOrder: index,
    })),
  }
}

/** Documents store one tax rate across lines; recover it from stored totals. */
export function impliedTaxRate(document: {
  subtotalNet: { toNumber(): number }
  totalTax: { toNumber(): number }
  items?: ReadonlyArray<{ taxRate: { toNumber(): number } }>
}) {
  // Lines store the nominal rate. Deriving it from rounded totals drifts (25% on 105 JPY rounds to
  // 26 tax, which reads back as 24.76%), so totals are only a fallback for documents without lines.
  const lineRate = document.items?.[0]?.taxRate.toNumber()
  if (lineRate !== undefined) {
    return lineRate
  }
  const net = document.subtotalNet.toNumber()
  return net > 0 ? (document.totalTax.toNumber() / net) * 100 : 0
}
