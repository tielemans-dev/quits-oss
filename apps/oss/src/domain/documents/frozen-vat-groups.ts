import { frozenVatGroupSchema, type FrozenVatGroup } from "@quits/contracts/pricing"
import { vatGroupKey, percentageToFraction } from "@quits/shared/pricing"
import { toDecimal } from "../../lib/exports/format"
import { documentFractionDigits } from "./pricing"

/** Issued lines and evidence are frozen. Recover groups by summing them, never reprice inputs. */
export function frozenVatGroups(document: {
  currency: string
  vatEvidence?: unknown
  items: Array<{
    vatTreatment: string
    vatReasonCode: string | null
    vatCountry: string | null
    vatRateInput?: string | null
    taxRate: { toString(): string }
    lineNet: { toString(): string }
    lineTax: { toString(): string }
    lineGross: { toString(): string }
  }>
}): FrozenVatGroup[] {
  const groups = new Map<string, FrozenVatGroup>()
  const exponent = documentFractionDigits(document.currency)
  for (const line of document.items) {
    const vat = {
      treatment: line.vatTreatment, reasonCode: line.vatReasonCode, country: line.vatCountry,
      rate: line.vatRateInput ?? percentageToFraction(line.taxRate.toString()),
    }
    const key = vatGroupKey(vat)
    const group = groups.get(key) ?? frozenVatGroupSchema.parse({
      ...vat, key, exponent, baseExponent: exponent, net: "0", tax: "0", gross: "0", payableRounding: "0",
      netBase: null, taxBase: null, grossBase: null, payableRoundingBase: null,
      ...(document.vatEvidence ? { evidence: document.vatEvidence } : {}),
    })
    group.net = toDecimal(group.net).plus(line.lineNet.toString()).toFixed(exponent)
    group.tax = toDecimal(group.tax).plus(line.lineTax.toString()).toFixed(exponent)
    group.gross = toDecimal(group.gross).plus(line.lineGross.toString()).toFixed(exponent)
    group.payableRounding = toDecimal(group.gross).minus(group.net).minus(group.tax).toFixed(exponent)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))
}
