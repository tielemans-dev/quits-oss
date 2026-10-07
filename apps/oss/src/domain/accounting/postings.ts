import { moneyMinor, validateVatIssuance, vatGroupKey } from "@quits/shared/pricing"
import { requireCurrencyExponent } from "@quits/shared/currency"
import { invoiceIssuedSchema, creditNoteIssuedSchema } from "../events/money"

export const postingRoles = ["debtor", "revenue", "output_vat", "payable_rounding", "fx_gain", "fx_loss", "customer_credit"] as const
export type PostingRole = typeof postingRoles[number]
/** All amounts are decimal strings of integer base minor units. Zero groups retain revenue lines. */
export type Posting = {
  role: PostingRole
  debitMinor: string
  creditMinor: string
  currency: string
  exponent: 0 | 1 | 2
  vatGroup: string | null
}
export type PostingRefusalCode =
  | "base_valuation_unknown" | "not_postable" | "tax_point_review_required"
  | "unsupported_treatment_combination" | "purpose_not_supported" | "advances_not_supported"
  | "applications_not_supported" | "equation_violation" | "event_not_supported"
export type PostingRefusal = { code: PostingRefusalCode; detail: string }
export type PostingEvent = { type: string; schemaVersion: number; payload: unknown }
const refuse = (code: PostingRefusalCode, detail: string): PostingRefusal => ({ code, detail })
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const nonempty = (value: unknown) => Array.isArray(value) && value.length > 0

/** Pure Phase A policy. Reads only the versioned event, never document rows or current rates. */
export function postingsFor(event: PostingEvent): Posting[] | PostingRefusal {
  const credit = event.type === "credit_note.issued"
  if (event.type !== "invoice.issued" && !credit) return refuse("event_not_supported", event.type)
  const raw = record(event.payload)
  if (credit && (event.schemaVersion !== 2 || raw.postable !== true || raw.incompleteReason !== undefined))
    return refuse("not_postable", String(raw.incompleteReason ?? "Credit is not postable v2"))
  if (!credit && event.schemaVersion !== 1) return refuse("not_postable", "Unsupported invoice version")
  const valuation = record(raw.valuation)
  if (!raw.valuation || valuation.rateSource === "unknown" || record(valuation.base).minor == null || valuation.rate == null)
    return refuse("base_valuation_unknown", "No frozen base valuation")
  if ((credit ? raw.correctsPurpose : raw.purpose) !== "sale") return refuse("purpose_not_supported", "Only sales are supported")
  if (nonempty(raw.coveredByAdvances)) return refuse("advances_not_supported", "Covered advances require Phase C")
  if (nonempty(raw.depositApplications) || (credit && (raw.allocationsReleased === null || nonempty(raw.allocationsReleased) || raw.customerCreditCreated != null)))
    return refuse("applications_not_supported", "Applications and customer credit require positions")
  if (raw.taxPointReason === "advance_received") return refuse("advances_not_supported", "Advance tax point requires Phase C")
  if (raw.taxPointReason !== "invoice_issued" || raw.taxPointDate !== raw.issueDate || raw.supplyDate == null ||
      (!credit && String(raw.supplyDate) < String(raw.issueDate)))
    return refuse("tax_point_review_required", "Tax point requires review; no safe-harbour window")

  // Run the shared evidence guard before parsing: invalid treatment/rate combinations have their
  // own refusal even though the event registry correctly rejects them at issuance.
  const seller = record(raw.seller), buyer = record(raw.buyer)
  const sellerVatId = Array.isArray(seller.taxIds) ? seller.taxIds.map(record).find(id => id.scheme === "VAT")?.value : undefined
  const rawGroups = Array.isArray(raw.vatGroups) ? raw.vatGroups.map(record) : []
  if ((rawGroups.some(g => g.treatment === "out_of_scope") && rawGroups.some(g => g.treatment !== "out_of_scope")) || rawGroups.some(group => validateVatIssuance({
    lines: [{ treatment: String(group.treatment), rate: String(group.rate), country: typeof group.country === "string" ? group.country : null, reasonCode: typeof group.reasonCode === "string" ? group.reasonCode : null }],
    evidence: group.evidence, sellerVatId: typeof sellerVatId === "string" ? sellerVatId : undefined, buyerCountry: typeof buyer.country === "string" ? buyer.country : undefined,
  }).length)) return refuse("unsupported_treatment_combination", "Unsupported classification or incomplete frozen evidence")

  const parsed = credit ? creditNoteIssuedSchema.safeParse(raw) : invoiceIssuedSchema.safeParse(raw)
  if (!parsed.success || !("valuation" in parsed.data)) return refuse("not_postable", "Incomplete or invalid money payload")
  const p = parsed.data
  const base = p.valuation.base
  try {
    if (requireCurrencyExponent(p.currency) !== p.exponent || requireCurrencyExponent(base.currency) !== base.exponent)
      return refuse("not_postable", "Unsupported currency or exponent")
  } catch { return refuse("not_postable", "Unsupported currency") }
  if (p.calculation.exponent !== p.exponent || p.calculation.baseExponent !== base.exponent)
    return refuse("equation_violation", "Calculation exponents differ")
  if (p.vatGroups.some(g => [g.netBase, g.taxBase, g.grossBase, g.payableRoundingBase].some(v => v === null)) ||
      [p.totals.netBase, p.totals.taxBase, p.totals.grossBase, p.totals.payableRoundingBase].some(v => v === null))
    return refuse("base_valuation_unknown", "Frozen base components are unknown")

  try {
    const minor = (amount: string | null, exponent: number) => {
      if (amount === null) throw new Error("Unknown amount")
      return BigInt(moneyMinor(amount, exponent))
    }
    const keys = new Set<string>()
    for (const g of p.vatGroups) {
      if (keys.has(g.key) || g.key !== vatGroupKey(g) || g.exponent !== p.exponent || g.baseExponent !== base.exponent)
        throw new Error("Invalid or duplicate VAT group")
      keys.add(g.key)
      for (const [suffix, exponent] of [["", p.exponent], ["Base", base.exponent]] as const) {
        const net = minor(g[`net${suffix}`], exponent), tax = minor(g[`tax${suffix}`], exponent)
        const rounding = minor(g[`payableRounding${suffix}`], exponent), gross = minor(g[`gross${suffix}`], exponent)
        if (net + tax + rounding !== gross) throw new Error("Group equation fails")
        if (g.treatment !== "standard" && tax !== 0n) throw new Error("Zero-tax group has tax")
      }
    }
    for (const name of ["net", "tax", "gross", "payableRounding", "netBase", "taxBase", "grossBase", "payableRoundingBase"] as const) {
      const exponent = name.endsWith("Base") ? base.exponent : p.exponent
      const total = p.vatGroups.reduce((sum, g) => sum + minor(g[name], exponent), 0n)
      if (total !== minor(p.totals[name], exponent)) throw new Error("Group totals differ")
    }
    // Lines allocate net and tax independently; inclusive line gross need not equal net + tax.
    for (const g of p.vatGroups) for (const name of ["net", "tax", "gross"] as const) {
      const total = p.lines.filter(line => vatGroupKey(line.vat) === g.key).reduce((sum, line) => sum + minor(line[name], p.exponent), 0n)
      if (total !== minor(g[name], p.exponent)) throw new Error("Line allocation differs")
    }
    if (p.lines.some(line => !keys.has(vatGroupKey(line.vat)))) throw new Error("Line has no group")
    if (minor(p.totals.grossBase, base.exponent) !== BigInt(base.minor!)) throw new Error("Valuation differs from gross")

    const postings: Posting[] = []
    const add = (role: PostingRole, signed: bigint, debit: boolean, vatGroup: string | null) => {
      const onDebit = signed < 0n ? !debit : debit
      const absolute = (signed < 0n ? -signed : signed).toString()
      postings.push({ role, debitMinor: onDebit ? absolute : "0", creditMinor: onDebit ? "0" : absolute,
        currency: base.currency, exponent: base.exponent, vatGroup })
    }
    if ("historicalReversal" in p) {
      if (p.debtorDischarge.valuationSource !== "frozen_components" || p.debtorDischarge.carryingBase === null)
        return refuse("base_valuation_unknown", "Debtor carrying value is unknown")
      if (minor(p.fxDifferenceBase, base.exponent) !== 0n) throw new Error("Phase A has no FX bridge")
      if (p.debtorDischarge.quantity.currency !== p.currency || p.debtorDischarge.quantity.exponent !== p.exponent ||
          BigInt(p.debtorDischarge.quantity.minor!) !== minor(p.totals.gross, p.exponent)) throw new Error("Discharge quantity differs")
      if (p.historicalReversal.length !== keys.size || p.creditedGroups.length !== keys.size) throw new Error("Missing reversals")
      for (const g of p.vatGroups) {
        const reversals = p.historicalReversal.filter(r => r.key === g.key)
        const credited = p.creditedGroups.filter(c => c.original.key === g.key)
        if (reversals.length !== 1 || credited.length !== 1) throw new Error("Duplicate or missing reversal")
        const r = reversals[0]!, c = credited[0]!
        for (const [left, right] of [[r.revenueBase, g.netBase], [r.taxBase, g.taxBase], [r.roundingBase, g.payableRoundingBase],
          [c.netBase, g.netBase], [c.taxBase, g.taxBase], [c.payableRoundingBase, g.payableRoundingBase], [c.grossBase, g.grossBase]] as const)
          if (minor(left, base.exponent) !== minor(right, base.exponent)) throw new Error("Historical reversal differs")
        for (const [left, right] of [[c.creditedNet, g.net], [c.creditedTax, g.tax], [c.creditedGross, g.gross], [c.creditedRounding, g.payableRounding]] as const)
          if (minor(left, p.exponent) !== minor(right, p.exponent)) throw new Error("Credited portion differs")
        add("revenue", minor(r.revenueBase, base.exponent), true, g.key)
        if (minor(g.tax, p.exponent) !== 0n || minor(r.taxBase, base.exponent) !== 0n) add("output_vat", minor(r.taxBase, base.exponent), true, g.key)
        add("payable_rounding", minor(r.roundingBase, base.exponent), true, g.key)
      }
      add("debtor", minor(p.debtorDischarge.carryingBase, base.exponent), false, null)
    } else {
      add("debtor", minor(p.totals.grossBase, base.exponent), true, null)
      for (const g of p.vatGroups) {
        add("revenue", minor(g.netBase, base.exponent), false, g.key)
        if (minor(g.tax, p.exponent) !== 0n || minor(g.taxBase, base.exponent) !== 0n) add("output_vat", minor(g.taxBase, base.exponent), false, g.key)
        add("payable_rounding", minor(g.payableRoundingBase, base.exponent), false, g.key)
      }
    }
    // Construction invariant, using exact integers even beyond Number.MAX_SAFE_INTEGER.
    if (postings.reduce((sum, line) => sum + BigInt(line.debitMinor) - BigInt(line.creditMinor), 0n) !== 0n)
      throw new Error("Posting debits differ from credits")
    return postings
  } catch (error) { return refuse("equation_violation", error instanceof Error ? error.message : "Invalid frozen equation") }
}
