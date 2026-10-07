import type {
  ComputedLine,
  CountryProfile,
  TaxComputationInput,
  TaxComputationOutput,
} from "./country-profile"

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function round2(value: number): number {
  return roundTo(value, 2)
}

export function computeDocumentTotals(
  _profile: CountryProfile,
  input: TaxComputationInput
): TaxComputationOutput {
  const rate = input.taxRate / 100
  // Amounts follow the currency's precision so a document never owes a fraction the currency
  // cannot be paid in; unit prices stay at two decimals because they are per-unit references.
  const digits = input.fractionDigits ?? 2
  const roundAmount = (value: number) => roundTo(value, digits)

  let subtotalNet = 0
  let totalTax = 0
  let totalGross = 0
  const lines: ComputedLine[] = []

  for (const item of input.items) {
    const lineGrossInput = roundAmount(item.quantity * item.unitPrice)

    if (input.pricesIncludeTax) {
      const lineNet = roundAmount(lineGrossInput / (1 + rate))
      const lineTax = roundAmount(lineGrossInput - lineNet)
      const unitPriceNet = round2(item.quantity > 0 ? lineNet / item.quantity : 0)
      const unitPriceGross = round2(item.quantity > 0 ? lineGrossInput / item.quantity : 0)
      subtotalNet += lineNet
      totalTax += lineTax
      totalGross += lineGrossInput
      lines.push({
        description: item.description,
        quantity: item.quantity,
        unitPriceNet,
        unitPriceGross,
        lineNet,
        lineTax,
        lineGross: lineGrossInput,
        taxRate: input.taxRate,
      })
      continue
    }

    const lineNet = lineGrossInput
    const lineTax = roundAmount(lineNet * rate)
    const lineGross = roundAmount(lineNet + lineTax)
    const unitPriceNet = round2(item.quantity > 0 ? lineNet / item.quantity : 0)
    const unitPriceGross = round2(item.quantity > 0 ? lineGross / item.quantity : 0)
    subtotalNet += lineNet
    totalTax += lineTax
    totalGross += lineGross
    lines.push({
      description: item.description,
      quantity: item.quantity,
      unitPriceNet,
      unitPriceGross,
      lineNet,
      lineTax,
      lineGross,
      taxRate: input.taxRate,
    })
  }

  return {
    subtotalNet: roundAmount(subtotalNet),
    totalTax: roundAmount(totalTax),
    totalGross: roundAmount(totalGross),
    lines,
  }
}
