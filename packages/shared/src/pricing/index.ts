import Decimal from "decimal.js-light"
import {
  calculateDocumentInputSchema, creditComponentsInputSchema,
  type CalculateDocumentInput, type CalculateDocumentOutput,
  type CreditComponentsInput, type CreditComponentsOutput,
} from "@quits/contracts/pricing"
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

/** Pure v2 calculation. Legacy producers deliberately do not call this function. */
export function calculateDocument(raw: CalculateDocumentInput): CalculateDocumentOutput {
  const input = calculateDocumentInputSchema.parse(raw)
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
