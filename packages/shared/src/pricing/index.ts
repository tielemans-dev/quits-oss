import Decimal from "decimal.js-light"
import {
  calculateDocumentInputSchema, calculateDraftDocumentInputSchema, creditComponentsInputSchema,
  type CalculateDocumentInput, type CalculateDocumentOutput,
  type CreditComponentsInput, type CreditComponentsOutput,
} from "@quits/contracts/pricing"
import { vatClassificationSchema, vatEvidenceSchema } from "@quits/contracts/vat"
import type { VatGroup } from "@quits/contracts/vat"
import { requireCurrencyExponent } from "../currency"

// Isolated from callers' Decimal configuration. Input lengths and line counts are bounded.
const D = Decimal.clone({ precision: 1024, rounding: Decimal.ROUND_HALF_UP })
const sum = (values: Decimal[]) => values.reduce((total, value) => total.plus(value), new D(0))
const round = (value: Decimal, exponent: number) => value.toDecimalPlaces(exponent, D.ROUND_HALF_UP)
const money = (value: Decimal, exponent: number) => value.isZero() ? new D(0).toFixed(exponent) : value.toFixed(exponent)

/** Additive adapter for the later numeric UI transition; no currency rounding. */
export function decimalInput(value: string | number) {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Decimal input must be finite")
  return { value: String(value), inputPrecision: typeof value === "number" ? "number" as const : "string" as const }
}

/** Canonical rate spelling makes "0.25" and "0.2500" one group. */
export function vatGroupKey(vat: { treatment: string; reasonCode?: string | null; rate: string; country?: string | null }) {
  return JSON.stringify([vat.treatment, vat.reasonCode ?? null, new D(vat.rate).toFixed(), vat.country?.toUpperCase() ?? null])
}

/** Allocate integer minor units independently for each component. */
function allocate(total: Decimal, weights: Decimal[], orders: number[], exponent: number): Decimal[] {
  const weight = sum(weights)
  if (weight.isZero()) {
    if (!total.isZero()) throw new Error("Cannot allocate a nonzero component over zero gross")
    return weights.map(() => new D(0))
  }
  const scale = new D(10).pow(exponent)
  const units = total.times(scale)
  const shares = weights.map((value, index) => {
    const exact = units.times(value).div(weight)
    const floor = exact.toDecimalPlaces(0, D.ROUND_DOWN)
    return { index, floor, remainder: exact.minus(floor), order: orders[index]! }
  })
  const remaining = units.minus(sum(shares.map((share) => share.floor))).toNumber()
  const ranked = shares.slice().sort((a, b) => b.remainder.comparedTo(a.remainder) || a.order - b.order)
  for (let index = 0; index < remaining; index++) ranked[index]!.floor = ranked[index]!.floor.plus(1)
  return shares.map((share) => share.floor.div(scale))
}
function equation(left: Decimal, right: Decimal, exponent: number) {
  if (!left.eq(right)) throw new Error(`Document equation failed: ${left.toString()} != ${right.toString()}`)
  return { left: money(left, exponent), right: money(right, exponent), balanced: true as const }
}

/** Pure v2 calculation shared by draft producers and editors. */
export function calculateDocument(raw: CalculateDocumentInput): CalculateDocumentOutput {
  return calculateParsedDocument(calculateDocumentInputSchema.parse(raw))
}

function calculateParsedDocument(input: ReturnType<typeof calculateDocumentInputSchema.parse>): CalculateDocumentOutput {
  const exponent = requireCurrencyExponent(input.currency)
  const baseCurrency = input.baseCurrency ?? input.currency
  const baseExponent = requireCurrencyExponent(baseCurrency)
  const exchangeRate = new D(input.exchangeRate)
  if (baseCurrency === input.currency && !exchangeRate.eq(1)) throw new Error("Same-currency exchange rate must be one")
  const lines = input.lines.map((line) => ({
    ...line,
    groupKey: vatGroupKey(line.vat),
    amount: round(new D(line.quantity).times(line.unitPrice), exponent),
    net: "", tax: "", gross: "",
  }))
  const byKey = new Map<string, typeof lines>()
  for (const line of lines) {
    const group = byKey.get(line.groupKey) ?? []
    group.push(line)
    byKey.set(line.groupKey, group)
  }
  const groups: VatGroup[] = []
  for (const [key, members] of [...byKey].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const first = members[0]!
    const rate = new D(first.vat.rate)
    const amount = sum(members.map((line) => line.amount))
    const net = input.pricesIncludeTax ? round(amount.div(rate.plus(1)), exponent) : amount
    const tax = round(net.times(rate), exponent)
    const gross = input.pricesIncludeTax ? amount : net.plus(tax)
    const payableRounding = gross.minus(net).minus(tax)
    if (payableRounding.abs().gt(new D(1).div(new D(10).pow(exponent))))
      throw new Error("Payable rounding exceeds one minor unit")
    const weights = members.map((line) => line.amount)
    const orders = members.map((line) => line.sortOrder)
    const taxes = allocate(tax, weights, orders, exponent)
    const nets = input.pricesIncludeTax ? allocate(net, weights, orders, exponent) : weights
    members.forEach((line, index) => {
      line.net = money(nets[index]!, exponent)
      line.tax = money(taxes[index]!, exponent)
      line.gross = money(input.pricesIncludeTax ? line.amount : nets[index]!.plus(taxes[index]!), exponent)
    })
    const evidence = members.find((line) => line.evidence)?.evidence
    if (members.some((line) => line.evidence && JSON.stringify(line.evidence) !== JSON.stringify(evidence)))
      throw new Error("Conflicting evidence for one VAT group")
    const grossBase = round(gross.times(exchangeRate), baseExponent)
    const taxBase = round(tax.times(exchangeRate), baseExponent)
    const payableRoundingBase = round(payableRounding.times(exchangeRate), baseExponent)
    groups.push({
      ...first.vat, rate: rate.toFixed(), key, exponent, baseExponent,
      net: money(net, exponent), tax: money(tax, exponent), gross: money(gross, exponent),
      payableRounding: money(payableRounding, exponent),
      netBase: money(grossBase.minus(taxBase).minus(payableRoundingBase), baseExponent),
      taxBase: money(taxBase, baseExponent), grossBase: money(grossBase, baseExponent),
      payableRoundingBase: money(payableRoundingBase, baseExponent),
      ...(evidence ? { evidence } : {}),
    })
  }
  const component = (name: "net" | "tax" | "gross" | "payableRounding" | "netBase" | "taxBase" | "grossBase" | "payableRoundingBase") =>
    sum(groups.map((group) => new D(group[name])))
  const net = component("net"), tax = component("tax"), gross = component("gross"), payableRounding = component("payableRounding")
  const deposits = sum(input.depositApplicationsGross.map((value) => {
    const deposit = new D(value)
    if (!round(deposit, exponent).eq(deposit)) throw new Error("Deposit gross must use currency precision")
    return deposit
  }))
  if (deposits.gt(gross)) throw new Error("Deposit applications exceed gross")
  const payableGross = gross.minus(deposits)
  const netBase = component("netBase"), taxBase = component("taxBase"), payableRoundingBase = component("payableRoundingBase"), debtorBase = component("grossBase")
  return {
    currency: input.currency, baseCurrency, exchangeRate: exchangeRate.toFixed(),
    calculation: { version: "v2", roundingMode: "half_up", pricesIncludeTax: input.pricesIncludeTax, exponent, baseExponent },
    lines: lines.map(({ amount: _amount, ...line }) => line), groups,
    net: money(net, exponent), tax: money(tax, exponent), gross: money(gross, exponent),
    payableRounding: money(payableRounding, exponent), depositApplicationsGross: money(deposits, exponent), payableGross: money(payableGross, exponent),
    netBase: money(netBase, baseExponent), taxBase: money(taxBase, baseExponent), payableRoundingBase: money(payableRoundingBase, baseExponent), debtorBase: money(debtorBase, baseExponent),
    equations: {
      document: equation(net.plus(tax).plus(payableRounding).minus(deposits), payableGross, exponent),
      base: equation(netBase.plus(taxBase).plus(payableRoundingBase), debtorBase, baseExponent),
    },
  }
}

/** Differences of cumulative entitlements, including grossBase; never clamp signed net. */
export function creditComponents(raw: CreditComponentsInput): CreditComponentsOutput {
  const { group, cumulativeBefore, creditedGross } = creditComponentsInputSchema.parse(raw)
  const gross = new D(group.gross), before = new D(cumulativeBefore), credit = new D(creditedGross), cumulative = before.plus(credit)
  if (gross.lte(0) || credit.lte(0) || cumulative.gt(gross)) throw new Error("Credit exceeds remaining group gross or is not positive")
  for (const amount of [before, credit, gross])
    if (!round(amount, group.exponent).eq(amount)) throw new Error("Credit gross must use currency precision")
  for (const name of ["net", "tax", "payableRounding"] as const)
    if (!round(new D(group[name]), group.exponent).eq(group[name])) throw new Error("Frozen component must use currency precision")
  for (const name of ["netBase", "taxBase", "grossBase", "payableRoundingBase"] as const)
    if (!round(new D(group[name]), group.baseExponent).eq(group[name])) throw new Error("Frozen base component must use currency precision")
  equation(new D(group.net).plus(group.tax).plus(group.payableRounding), gross, group.exponent)
  equation(new D(group.netBase).plus(group.taxBase).plus(group.payableRoundingBase), new D(group.grossBase), group.baseExponent)
  const delta = (total: string, exponent: number) =>
    round(new D(total).times(cumulative).div(gross), exponent).minus(round(new D(total).times(before).div(gross), exponent))
  const tax = delta(group.tax, group.exponent), payableRounding = delta(group.payableRounding, group.exponent)
  const net = credit.minus(tax).minus(payableRounding)
  const grossBase = delta(group.grossBase, group.baseExponent), taxBase = delta(group.taxBase, group.baseExponent), payableRoundingBase = delta(group.payableRoundingBase, group.baseExponent)
  const netBase = grossBase.minus(taxBase).minus(payableRoundingBase)
  return {
    net: money(net, group.exponent), tax: money(tax, group.exponent), gross: money(credit, group.exponent), payableRounding: money(payableRounding, group.exponent),
    netBase: money(netBase, group.baseExponent), taxBase: money(taxBase, group.baseExponent), grossBase: money(grossBase, group.baseExponent), payableRoundingBase: money(payableRoundingBase, group.baseExponent),
    cumulativeGross: money(cumulative, group.exponent),
    equations: { document: equation(net.plus(tax).plus(payableRounding), credit, group.exponent), base: equation(netBase.plus(taxBase).plus(payableRoundingBase), grossBase, group.baseExponent) },
  }
}

/** Document percentage convenience; explicit per-line fractional rates take precedence. */
export function documentVat(line: import("@quits/contracts/invoices").DocumentLineInput, taxRate: string | number) {
  const rate = new D(String(taxRate)).div(100).toFixed()
  const treatment = line.vat?.treatment ?? (new D(rate).isZero() ? "out_of_scope" : "standard")
  return {
    treatment,
    rate: line.vat?.rate ?? (treatment === "standard" ? rate : "0"),
    country: line.vat?.country ?? null,
    reasonCode: line.vat?.reasonCode ?? null,
  }
}

/** Used by all v2 previews and producers. Decimal strings remain intact until calculation. */
export function calculateDraft(input: {
  items: import("@quits/contracts/invoices").DocumentLineInput[]
  taxRate: string | number
  currency: string
  pricesIncludeTax: boolean
  vatEvidence?: import("@quits/contracts/vat").DraftVatEvidence
}) {
  const evidence = vatEvidenceSchema.safeParse(input.vatEvidence)
  return calculateParsedDocument(calculateDraftDocumentInputSchema.parse({
    currency: input.currency,
    pricesIncludeTax: input.pricesIncludeTax,
    lines: input.items.map((line, sortOrder) => ({
      quantity: decimalInput(line.quantity).value,
      unitPrice: decimalInput(line.unitPrice).value,
      sortOrder,
      vat: documentVat(line, input.taxRate),
      ...(evidence.success ? { evidence: evidence.data } : {}),
    })),
  }))
}

/** UI inputs may be empty while typing; an invalid preview never displays guessed totals. */
export function previewDraft(input: Parameters<typeof calculateDraft>[0]) {
  try { return { result: calculateDraft(input), error: null } }
  catch (error) { return { result: null, error: error instanceof Error ? error.message : "Invalid decimal input" } }
}

const euCountries = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"])

/** Pure issuance guard. It validates stored classifications/evidence without repricing a document. */
export function validateVatIssuance(input: {
  lines: Array<{ treatment: string; rate: string; country?: string | null; reasonCode?: string | null }>
  evidence: unknown
  sellerVatId?: string | null
  buyerCountry?: string | null
}): string[] {
  const issues: string[] = []
  const evidence = vatEvidenceSchema.safeParse(input.evidence ?? {})
  if (!evidence.success) return ["Invalid VAT evidence"]
  const e = evidence.data
  const present = (value?: string | null) => Boolean(value?.trim())
  if (input.lines.some((line) => line.treatment === "out_of_scope") && input.lines.some((line) => line.treatment !== "out_of_scope"))
    issues.push("out_of_scope cannot mix with other treatments")
  for (const line of input.lines) {
    const classification = vatClassificationSchema.safeParse({ ...line, country: line.country ?? null, reasonCode: line.reasonCode ?? null })
    if (!classification.success) issues.push("Invalid VAT classification or rate")
    switch (line.treatment) {
      case "intra_community":
        if (!present(input.sellerVatId) || !present(e.buyerVatId) || e.viesCheck?.result !== "valid" || !present(e.statementText))
          issues.push("Intra-community supply requires seller and buyer VAT ids, valid VIES and a statement")
        break
      case "export": {
        const country = input.buyerCountry?.toUpperCase()
        if (!e.exportEvidence || !present(e.exportEvidence.ref) || !country || !/^[A-Z]{2}$/.test(country) || euCountries.has(country))
          issues.push("Export requires evidence and a buyer country outside the EU")
        break
      }
      case "exempt":
        if (!present(e.statementText)) issues.push("Exemption requires reason text")
        break
      case "reverse_charge_domestic": case "zero_rated": case "unclassified_zero":
        issues.push(`${line.treatment} is refused in Phase A`)
        break
    }
  }
  return [...new Set(issues)]
}

/** Frozen v1 offer calculation. Do not change the arithmetic or snapshot fixtures. */
function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function round2(value: number): number {
  return roundTo(value, 2)
}

export function calculateLegacyDocument(input: {
  items: Array<{ description: string; quantity: number; unitPrice: number }>
  taxRate: number
  pricesIncludeTax: boolean
  fractionDigits?: number
}) {
  const rate = input.taxRate / 100
  // Amounts follow the currency's precision so a document never owes a fraction the currency
  // cannot be paid in; unit prices stay at two decimals because they are per-unit references.
  const digits = input.fractionDigits ?? 2
  const roundAmount = (value: number) => roundTo(value, digits)

  let subtotalNet = 0
  let totalTax = 0
  let totalGross = 0
  const lines: Array<{ description: string; quantity: number; unitPriceNet: number; unitPriceGross: number; lineNet: number; lineTax: number; lineGross: number; taxRate: number }> = []

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


export function percentageToFraction(value: string | number) { return new D(String(value)).div(100).toFixed() }
export function decimalReferencePrices(quantity: string, net: string, gross: string) {
  return { unitPriceNet: new D(net).div(quantity).toFixed(2), unitPriceGross: new D(gross).div(quantity).toFixed(2) }
}

export function fractionToPercentage(value: string) { return new D(value).times(100).toFixed() }

/** Assert the document equation from persisted amounts, never from recalculated inputs. */
export function assertStoredDocumentEquation(input: {
  currency: string
  pricesIncludeTax: boolean
  net: string
  tax: string
  gross: string
  lines: Array<{ vat: { treatment: string; reasonCode?: string | null; rate: string; country?: string | null }; net: string; tax: string; gross: string }>
}) {
  const exponent = requireCurrencyExponent(input.currency)
  const groups = new Map<string, { net: Decimal; tax: Decimal; gross: Decimal }>()
  for (const line of input.lines) {
    for (const value of [line.net, line.tax, line.gross]) {
      const amount = new D(value)
      if (amount.lt(0) || !round(amount, exponent).eq(amount)) throw new Error("Invalid stored line precision")
    }
    const key = vatGroupKey(line.vat)
    const group = groups.get(key) ?? { net: new D(0), tax: new D(0), gross: new D(0) }
    group.net = group.net.plus(line.net); group.tax = group.tax.plus(line.tax); group.gross = group.gross.plus(line.gross)
    groups.set(key, group)
  }
  const totals = [...groups.values()]
  for (const name of ["net", "tax", "gross"] as const) {
    const amount = new D(input[name])
    if (!round(amount, exponent).eq(amount) || !sum(totals.map((group) => group[name])).eq(amount))
      throw new Error("Stored document totals do not match its lines")
  }
  for (const group of totals) {
    const rounding = group.gross.minus(group.net).minus(group.tax)
    if ((!input.pricesIncludeTax && !rounding.isZero()) || rounding.abs().gt(new D(1).div(new D(10).pow(exponent))))
      throw new Error("Invalid stored payable rounding")
  }
  return equation(new D(input.net).plus(input.tax).plus(sum(totals.map((group) => group.gross.minus(group.net).minus(group.tax)))), new D(input.gross), exponent)
}

/** Value frozen amounts without repricing their original inputs. Rule 7 owns the residual. */
export function valueFrozenGroups(groups: import("@quits/contracts/pricing").FrozenVatGroup[], baseCurrency: string, rate: string) {
  const baseExponent = requireCurrencyExponent(baseCurrency)
  const exchangeRate = new D(rate)
  if (exchangeRate.lte(0)) throw new Error("Exchange rate must be positive")
  return groups.map(group => {
    const grossBase = round(new D(group.gross).times(exchangeRate), baseExponent)
    const taxBase = round(new D(group.tax).times(exchangeRate), baseExponent)
    const payableRoundingBase = round(new D(group.payableRounding).times(exchangeRate), baseExponent)
    return { ...group, baseExponent,
      grossBase: money(grossBase, baseExponent), taxBase: money(taxBase, baseExponent),
      payableRoundingBase: money(payableRoundingBase, baseExponent),
      netBase: money(grossBase.minus(taxBase).minus(payableRoundingBase), baseExponent) }
  })
}

/** Decimal money to integer minor units, refusing sub-minor inputs. */
export function moneyMinor(amount: string, exponent: number) {
  const value = new D(amount).times(new D(10).pow(exponent))
  if (!value.isInteger()) throw new Error("Money has sub-minor precision")
  return value.toFixed(0)
}
