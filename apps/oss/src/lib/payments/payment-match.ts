import { getCurrencyExponent } from "@quits/shared/currency"

import { near, normalize } from "../request-parser"

/** Money that arrived, as a person or a bank feed describes it. Amounts are whole minor units (øre). */
export type IncomingPayment = { payer: string; amountMinor: number; currency: string; reference: string }

export type MatchInvoice = {
  id: string
  number: string | null
  status: string
  paymentStatus: string
  balanceDue: number
  currency: string
  contact: { name: string }
}

export type Candidate = {
  invoice: MatchInvoice
  /** What the invoice still owes after this payment, in minor units. Never negative. */
  shortMinor: number
  byReference: boolean
  nameScore: number
}

/** One card for a settled case; a shortlist the person picks from for anything less sure; or nothing. */
export type PaymentMatch = { kind: "exact"; candidate: Candidate } | { kind: "shortlist"; candidates: Candidate[] } | { kind: "none" }

/** A transfer may fall short of the balance by this much (bank fees, rounding) and still be offered. 50.00 kr. */
export const TOLERANCE_MINOR = 5000
const NAME_MIN = 0.5
const COLLECTIBLE = new Set(["sent", "viewed", "overdue"])
const LEGAL_FORM = new Set(["aps", "as", "a", "s", "ivs", "is", "i", "k", "smba", "amba"])

const exponentOf = (currency: string) => getCurrencyExponent(currency) ?? 2

/** An amount from the server (a JSON number with at most `exponent` decimals) in minor units. */
export const toMinor = (value: number, currency: string) => Math.round(value * 10 ** exponentOf(currency))

/** "1.250,50" or "1250" to minor units, read as text so no floating point is involved. Null if it is not an amount. */
export function parseAmountMinor(text: string): number | null {
  const m = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/.exec(text.trim())
  if (!m) return null
  const whole = Number(m[1]!.replaceAll(".", ""))
  return Number.isSafeInteger(whole * 100) ? whole * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0) : null
}

const words = (value: string) => normalize(value).split(" ").filter(Boolean)

/** The invoice number appears in the reference as the same run of words ("INV-0042" ~ "inv 0042") or glued ("INV0042"). */
function mentions(reference: string, number: string | null): boolean {
  const wanted = words(number ?? "")
  if (!wanted.length) return false
  const found = words(reference)
  const glued = wanted.join("")
  return found.includes(glued) || found.some((_, i) => wanted.every((word, j) => found[i + j] === word))
}

/** 0 to 1: how much of the shorter name the other has, word by word, ignoring A/S, ApS and the like. */
function nameScore(payer: string, customer: string): number {
  const strip = (name: string) => words(name).filter(word => !LEGAL_FORM.has(word))
  const a = strip(payer), b = strip(customer)
  if (!a.length || !b.length) return 0
  const shared = a.filter(word => b.some(other => near(word, other))).length
  return shared / Math.max(a.length, b.length)
}

/**
 * Logic only, no model. Exact amount plus the invoice number in the reference settles it: one card.
 * Otherwise an amount within tolerance and a similar name make a ranked shortlist, and a person picks.
 * A transfer above the balance matches nothing: it cannot be recorded against one invoice.
 */
export function matchPayment(payment: IncomingPayment, invoices: readonly MatchInvoice[]): PaymentMatch {
  const candidates: Candidate[] = []
  for (const invoice of invoices) {
    if (!COLLECTIBLE.has(invoice.status) || invoice.paymentStatus === "paid" || invoice.currency !== payment.currency) continue
    const shortMinor = toMinor(invoice.balanceDue, invoice.currency) - payment.amountMinor
    if (shortMinor < 0 || shortMinor > TOLERANCE_MINOR) continue
    candidates.push({ invoice, shortMinor, byReference: mentions(payment.reference, invoice.number), nameScore: nameScore(payment.payer, invoice.contact.name) })
  }
  const settled = candidates.filter(c => c.shortMinor === 0 && c.byReference)
  if (settled.length === 1) return { kind: "exact", candidate: settled[0]! }
  const ranked = (settled.length ? settled : candidates.filter(c => c.byReference || c.nameScore >= NAME_MIN)).sort(
    (a, b) => Number(b.byReference) - Number(a.byReference) || b.nameScore - a.nameScore || a.shortMinor - b.shortMinor || (a.invoice.id < b.invoice.id ? -1 : 1)
  )
  return ranked.length ? { kind: "shortlist", candidates: ranked } : { kind: "none" }
}

const AMOUNT = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?`
const paymentPattern = new RegExp(String.raw`^\s*betaling(?:\s+modtaget)?(?:\s+fra\s+(.+?))?\s+(${AMOUNT})\s*kr\.?(?:\s+ref(?:erence)?\.?:?\s*(.*?))?\s*$`, "iu")

/** "betaling modtaget fra Havbrise 1.250,50 kr ref faktura F-1042". Kroner only; null for anything else. */
export function parsePaymentRequest(input: string): IncomingPayment | null {
  const m = paymentPattern.exec(input)
  const amountMinor = m && parseAmountMinor(m[2]!)
  return m && amountMinor ? { payer: (m[1] ?? "").trim(), amountMinor, currency: "DKK", reference: (m[3] ?? "").trim() } : null
}
