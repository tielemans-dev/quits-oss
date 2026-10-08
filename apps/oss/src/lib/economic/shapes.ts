import { requireCurrencyExponent } from "@quits/shared/currency"
import { EconomicError, ExactNumber, sha256 } from "./client"

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EconomicError("invalid_response")
  return value as Record<string, unknown>
}
export function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 10_000) throw new EconomicError("invalid_response")
  return value
}
export function integer(value: unknown): string {
  if (!(value instanceof ExactNumber)) throw new EconomicError("invalid_response")
  const result = value.lexeme
  if (!/^(0|[1-9]\d{0,14})$/.test(result)) throw new EconomicError("invalid_response")
  return result
}
export function date(value: unknown): string {
  const result = text(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) throw new EconomicError("invalid_response")
  return result
}
export function currency(value: unknown): string {
  const result = text(value)
  try { requireCurrencyExponent(result) } catch { throw new EconomicError("invalid_response") }
  return result
}
export function decimal(value: unknown): string {
  if (!(value instanceof ExactNumber)) throw new EconomicError("invalid_response")
  const result = value.lexeme
  if (!/^-?(0|[1-9]\d{0,14})(\.\d{1,8})?$/.test(result)) throw new EconomicError("invalid_response")
  return result
}
export function minor(value: unknown, code: string): string {
  const amount = decimal(value)
  const exponent = requireCurrencyExponent(code)
  const [whole, fraction = ""] = amount.split(".")
  if (fraction.slice(exponent).replace(/0/g, "")) throw new EconomicError("invalid_response")
  const abs = BigInt(whole!.replace("-", "")) * 10n ** BigInt(exponent) + BigInt(fraction.slice(0, exponent).padEnd(exponent, "0") || "0")
  return (amount.startsWith("-") ? -abs : abs).toString()
}
export type Kind = "customer" | "invoice" | "entry" | "pair" | "attachment" | "year"
export type SourceRecord = { kind: Kind; sourceId: string; sourceHash: string; source: Record<string, unknown>; data: Record<string, unknown> }
/** Stable hashes compare source records without relying on property order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  return JSON.stringify(value)
}
export function normalize(kind: Kind, input: unknown, baseCurrency: string): SourceRecord {
  const row = object(input)
  let sourceId: string
  let data: Record<string, unknown>
  switch (kind) {
    case "customer": {
      sourceId = integer(row.customerNumber)
      data = { name: text(row.name), currency: row.currency === undefined ? null : currency(row.currency), balanceBase: row.balance === undefined ? null : minor(row.balance, baseCurrency) }
      for (const key of ["country", "vatNumber", "corporateIdentificationNumber", "ean", "email", "address", "zip", "city"]) data[key] = row[key] === undefined ? null : text(row[key])
      break
    }
    case "invoice": {
      sourceId = integer(row.bookedInvoiceNumber)
      const code = currency(row.currency)
      data = { customerId: integer(object(row.customer).customerNumber), date: date(row.date), dueDate: row.dueDate === undefined ? null : date(row.dueDate), currency: code, exchangeRate: decimal(row.exchangeRate), vatTreatment: "unclassified", residualBasis: "source_snapshot_only" }
      for (const key of ["netAmount", "vatAmount", "grossAmount", "remainder"]) data[key] = minor(row[key], code)
      for (const key of ["grossAmountInBaseCurrency", "remainderInBaseCurrency"]) data[key] = minor(row[key], baseCurrency)
      data.roundingAmount = row.roundingAmount === undefined ? null : minor(row.roundingAmount, code)
      data.pdf = row.pdf === undefined ? null : text(object(row.pdf).download)
      break
    }
    case "entry": {
      sourceId = integer(row.entryNumber)
      const code = row.currencyCode == null ? baseCurrency : currency(row.currencyCode)
      data = { accountNumber: integer(row.accountNumber), currency: code, date: date(row.date), type: integer(row.type), amount: minor(row.amount, code), amountInBaseCurrency: minor(row.amountInBaseCurrency, baseCurrency), remainder: row.remainder == null ? null : minor(row.remainder, code) }
      for (const key of ["voucherNumber", "customerNumber", "customerInvoiceNumber"]) data[key] = row[key] == null ? null : integer(row[key])
      break
    }
    case "pair": {
      const from = integer(row.fromEntry), to = integer(row.toEntry)
      sourceId = `${from}:${to}`
      // These are full entry amounts, never allocations. Currency requires the entry join.
      data = { fromEntry: from, toEntry: to, fromEntryDate: date(row.fromEntryDate), toEntryDate: date(row.toEntryDate) }
      for (const key of ["fromEntryAmount", "fromEntryAmountDKK", "toEntryAmount", "toEntryAmountDKK"]) data[key] = decimal(row[key])
      break
    }
    case "attachment":
      sourceId = integer(row.number)
      data = { accountingYear: text(row.accountingYear), voucherNumber: integer(row.voucherNumber), pageCount: integer(row.pageCount) }
      break
    case "year":
      sourceId = text(row.year)
      data = { fromDate: date(row.fromDate), toDate: date(row.toDate) }
      if (data.fromDate! > data.toDate!) throw new EconomicError("invalid_response")
      break
  }
  if (!sourceId) throw new EconomicError("invalid_response")
  return { kind, sourceId, sourceHash: sha256(canonical(row)), source: row, data }
}
