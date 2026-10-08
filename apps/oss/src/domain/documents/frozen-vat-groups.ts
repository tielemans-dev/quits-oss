import { frozenVatGroupSchema, type FrozenVatGroup } from "@quits/contracts/pricing"
import { vatGroupKey, percentageToFraction, fractionToPercentage } from "@quits/shared/pricing"
import { toDecimal } from "../../lib/exports/format"
import { documentFractionDigits } from "./pricing"
import type { VatRow } from "../../lib/documents/line-amounts"

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

/**
 * VAT groups collapsed to one row per rate, for display. Groups that differ only in treatment,
 * country or reason (a standard 0 % and an exempt line, say) share a rate and so one row. Sums are
 * exact decimals of the stored group amounts; nothing is repriced.
 */
export function vatRowsByRate(
  groups: ReadonlyArray<{ rate: string; net: string; tax: string; gross: string }>,
  currency: string
): VatRow[] {
  const exponent = documentFractionDigits(currency)
  const rows = new Map<string, VatRow>()
  for (const group of groups) {
    const ratePercent = fractionToPercentage(group.rate)
    const row = rows.get(ratePercent) ?? { ratePercent, net: "0", tax: "0", gross: "0" }
    row.net = toDecimal(row.net).plus(group.net).toFixed(exponent)
    row.tax = toDecimal(row.tax).plus(group.tax).toFixed(exponent)
    row.gross = toDecimal(row.gross).plus(group.gross).toFixed(exponent)
    rows.set(ratePercent, row)
  }
  return [...rows.values()].sort((a, b) => toDecimal(a.ratePercent).comparedTo(b.ratePercent))
}

/** The VAT of an issued or draft document by rate, from its stored lines. */
export const frozenVatRows = (document: Parameters<typeof frozenVatGroups>[0]) =>
  vatRowsByRate(frozenVatGroups(document), document.currency)
