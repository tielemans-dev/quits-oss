import type { CatalogItemOption } from "./catalog"
import { quantityDecimalSchema, unitPriceDecimalSchema } from "@quits/contracts/invoices"

export type RequestCustomer = { id: string; name: string; cvr?: string | null }
export type RequestContext = {
  customers: readonly RequestCustomer[]
  catalogItems: readonly CatalogItemOption[]
}
export type CustomerMatch = {
  /** Fuzzy matches are suggestions that require customer confirmation. */
  status: "matched" | "suggested" | "ambiguous" | "unknown" | "missing"
  query: string
  candidates: RequestCustomer[]
}
export type RequestLine = {
  description: string
  quantity?: string
  unitPrice?: string
  unit?: "hour" | "piece"
  catalogItemId?: string
}
export type RequestDraft = {
  intent: "invoice" | "overdue"
  customer?: CustomerMatch
  items: RequestLine[]
  /** Rule strength from 0 to 1, not a probability or permission to act. */
  confidence: number
  remainder: string
}

const number = String.raw`(?:[1-9]\d{0,2}(?:[. \u00a0\u202f]\d{3})+|0|[1-9]\d*)(?:,\d{1,6})?`
const boundary = String.raw`(?![\p{L}\p{N},]|\.\d|\s+\d)`
const quantityPattern = new RegExp(String.raw`^(${number})\s*(?:(timer|time|t|stk\.?)(?![\p{L}\p{N}])|(?=[àax]\s*\d))`, "iu")
const pricePattern = new RegExp(String.raw`^(${number})\s*kr\.?${boundary}`, "iu")
const separatedPrice = new RegExp(String.raw`^\s*[àax]\s*(${number})\s*kr\.?${boundary}`, "iu")
const canonical = (value: string) => value.replace(/[.\s]/g, "").replace(",", ".")
const tidy = (value: string) => value.trim().replace(/\s+/g, " ")
const normalize = (value: string) => tidy(value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " "))
const cvrDigits = (value: string) => value.replace(/^dk\s*/i, "").replace(/\s/g, "")

// One insertion, deletion or substitution; short names require an exact match.
function near(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false
  let i = 0, j = 0, edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (a.length >= b.length) i++
    if (b.length >= a.length) j++
  }
  return edits + a.length - i + b.length - j <= 1
}

function matchCustomer(query: string, customers: readonly RequestCustomer[]): CustomerMatch {
  const key = normalize(query)
  const digits = cvrDigits(query.replace(/^cvr\s*:?\s*/i, ""))
  const byCvr = /^\d{8}$/.test(digits)
  const exact = customers.filter(c => byCvr ? c.cvr && cvrDigits(c.cvr) === digits : normalize(c.name) === key)
  const candidates = !key ? [] : exact.length || byCvr ? exact : customers.filter(c => {
    const name = normalize(c.name)
    const prefix = name.split(" ").slice(0, key.split(" ").length).join(" ")
    return near(key, name) || near(key, prefix)
  })
  // Stable ordering keeps ambiguity independent of the caller's list order.
  candidates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const fuzzy = candidates.length === 1 && !exact.length && !normalize(candidates[0]!.name).startsWith(key + " ")
  return { query, candidates, status: !key ? "missing" : candidates.length === 1 ? fuzzy ? "suggested" : "matched" : candidates.length ? "ambiguous" : "unknown" }
}

/** Pure Danish command parser. Supply only the current org's customers/catalogue.
 * Returns null for ordinary search; drafts need confirmation and existing invoice
 * validation/calculation. No tax, totals, dates, IO, or context mutation occur here.
 * Supports one line; unsupported text stays in remainder. Decimal fields use dots.
 */
export function parseRequest(input: string, context: RequestContext): RequestDraft | null {
  const overdue = /^\s*(?:vis\s+forfaldne(?:\s+fakturaer)?|hvem\s+har\s+ikke\s+betalt)(?!\p{L})[?!.]?/iu.exec(input)
  if (overdue) {
    const remainder = input.slice(overdue[0].length).trim()
    return { intent: "overdue", items: [], confidence: remainder ? 0.8 : 1, remainder }
  }
  const invoice = /^\s*(?:faktura\s+til|fakturer)(?:\s+|$)/iu.exec(input)
  if (!invoice) return null
  const body = input.slice(invoice[0].length).trim()
  const cvr = /^(?:cvr\s*:?\s*)?(?:dk\s*)?\d{8}(?![\p{L}\p{N}])/iu.exec(body)
  // Only a numeric expression with a unit, currency or price separator starts a
  // line. Digits in names such as Studio 54 ApS and 3Shape A/S remain names.
  const lineStart = cvr ? cvr[0].length : body.search(/(?<!\S)(?:[+\p{Pd}\u2212]\s*)?\d[\d.,\s]*(?:e[+-]?\d+)?\s*(?:timer|time|t|stk\.?|kr\.?|[àax])(?=$|[\s.,]|\d)/iu)
  const customer = matchCustomer((lineStart < 0 ? body : body.slice(0, lineStart)).trim(), context.customers)
  let rest = lineStart < 0 ? "" : body.slice(lineStart).trim()
  const line: RequestLine = { description: "" }
  const quantity = quantityPattern.exec(rest)
  if (quantity && quantityDecimalSchema.safeParse(canonical(quantity[1]!)).success) {
    line.quantity = canonical(quantity[1]!)
    if (quantity[2]) line.unit = /^stk/i.test(quantity[2]) ? "piece" : "hour"
    const end = quantity.index + quantity[0].length
    const price = separatedPrice.exec(rest.slice(end))
    const validPrice = price && unitPriceDecimalSchema.safeParse(canonical(price[1]!)).success
    if (validPrice) line.unitPrice = canonical(price[1]!)
    rest = rest.slice(end + (validPrice ? price[0].length : 0))
  }
  if (!quantity) {
    const price = pricePattern.exec(rest)
    if (price && unitPriceDecimalSchema.safeParse(canonical(price[1]!)).success) {
      line.unitPrice = canonical(price[1]!)
      rest = rest.slice(0, price.index) + rest.slice(price.index + price[0].length)
    }
  }
  rest = tidy(rest)
  const catalogMatches = context.catalogItems.filter(item => normalize(item.name) === normalize(rest) && rest !== "")
  if (catalogMatches.length === 1) {
    const item = catalogMatches[0]!
    line.catalogItemId = item.id
    line.description = item.description?.trim() || item.name
    if (!line.unitPrice && unitPriceDecimalSchema.safeParse(String(item.defaultUnitPrice)).success) line.unitPrice = String(item.defaultUnitPrice)
    rest = ""
  }
  const items = line.quantity || line.unitPrice || line.catalogItemId ? [line] : []
  if (!items.length && !cvr && !/\p{L}/u.test(customer.query)) return null
  return {
    intent: "invoice", customer, items,
    confidence: customer.status === "matched" ? rest ? 0.8 : 1 : customer.status === "suggested" ? 0.6 : 0.5,
    remainder: rest,
  }
}
