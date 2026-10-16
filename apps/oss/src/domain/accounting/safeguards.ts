import { createHash } from "node:crypto"
import { z } from "zod"
import { moneyMinor } from "@quits/shared/pricing"
import type { AccountingEvent } from "./provider"

const fields = ["net", "tax", "gross"] as const
export const totalsSchema = z.object({ net: z.string(), tax: z.string(), gross: z.string() })
export type Totals = z.infer<typeof totalsSchema>
/** Exact DKK minor units. JSON numbers are read as decimal text, never multiplied as floats. */
function minor(value: string | number): bigint {
  return BigInt(moneyMinor(String(value), 2))
}
export function equalTotals(a: Totals, b: Totals): boolean {
  try { return fields.every(key => minor(a[key]) === minor(b[key])) } catch { return false }
}

/** Stable across PostgreSQL JSON key ordering. Arrays retain their order. */
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonical(x)])) : v
  return createHash("sha256").update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))).digest("hex")
}

/** Independent check of the final HTTP body, after connection request conversion. */
export function payloadTotalsMatch(event: AccountingEvent, request: { providerId: string; path: string; body: unknown; expectedTotals: Totals }): boolean {
  try {
    if (!["economic", "dinero"].includes(request.providerId)) return false
    if (event.type === "payment.recorded") {
      const p = z.object({ amount: z.string(), currency: z.literal("DKK") }).parse(event.payload)
      const body = z.object({ Amount: z.number(), RemainderIsFee: z.literal(false) }).parse(request.body)
      return request.providerId === "dinero" && /^\/invoices\/[^/]+\/payments$/.test(request.path) && minor(body.Amount) === minor(p.amount)
        && equalTotals(request.expectedTotals, { net: "0", tax: "0", gross: p.amount })
    }
    const p = z.object({ currency: z.literal("DKK"), exponent: z.literal(2), totals: totalsSchema,
      lines: z.array(totalsSchema.extend({ vat: z.object({ rate: z.enum(["0", "0.25"]) }) })) }).parse(event.payload)
    const credit = event.type === "credit_note.issued", sign = credit ? -1n : 1n
    const economic = request.providerId === "economic"
    const body = economic ? z.object({ currency: z.literal("DKK"), lines: z.array(z.object({ quantity: z.number(), unitNetPrice: z.number() })) }).parse(request.body)
      : z.object({ Currency: z.literal("DKK"), ShowLinesInclVat: z.literal(false), ProductLines: z.array(z.object({ Quantity: z.literal(1), BaseAmountValue: z.number(), Discount: z.literal(0) })) }).parse(request.body)
    if (request.path !== (economic ? "/invoices/drafts" : credit ? "/sales/creditnotes" : "/invoices")) return false
    const lines = "lines" in body ? body.lines.map(l => ({ quantity: l.quantity, price: l.unitNetPrice }))
      : body.ProductLines.map(l => ({ quantity: l.Quantity, price: l.BaseAmountValue }))
    if (lines.length !== p.lines.length) return false
    const sum = { net: 0n, tax: 0n, gross: 0n }
    for (const [i, line] of lines.entries()) {
      const source = p.lines[i]!
      if (line.quantity !== (economic && credit ? -1 : 1)) return false
      const net = minor(line.price)
      if (net < 0n) return false
      const tax = source.vat.rate === "0.25" ? (net + 2n) / 4n : 0n
      const amounts = { net, tax, gross: net + tax }
      for (const key of fields) {
        if (amounts[key] !== minor(source[key])) return false
        sum[key] += amounts[key]
      }
    }
    return fields.every(key => sum[key] === minor(p.totals[key]) && sign * sum[key] === minor(request.expectedTotals[key]))
  } catch { return false }
}
