import { calculateDocument, moneyMinor, vatGroupKey } from "@quits/shared/pricing"
import { creditNoteIssuedSchema, invoiceIssuedSchema } from "../events/money"
import { postingsFor } from "./postings"
import type { AccountingProvider, AccountingRefusal } from "./provider"

/** Resolved within one org/connection; product groups supply sales accounts and VAT codes. */
export type EconomicSettings = {
  customerNumber: number
  layoutNumber: number
  paymentTermsNumber: number // Must refer to a dueDate payment term.
  vatMappings: Record<string, { productNumber: string; vatZoneNumber: number }>
}
type EconomicDraft = {
  currency: string
  date: string
  dueDate: string
  customer: { customerNumber: number }
  layout: { layoutNumber: number }
  paymentTerms: { paymentTermsNumber: number }
  recipient: { name: string; vatZone: { vatZoneNumber: number } }
  references: { other: string }
  lines: Array<{ lineNumber: number; sortKey: number; description: string; product: { productNumber: string }; quantity: number; unitNetPrice: number }>
}
const refuse = (code: string, detail: string): AccountingRefusal => ({ status: "refused", code, detail })

/** JSON numbers are a boundary conversion only; all money checks use shared Decimal helpers. */
function apiAmount(amount: string, credit: boolean): number {
  const minor = BigInt(moneyMinor(amount, 2))
  if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe money amount")
  const value = Number(credit && minor !== 0n ? `-${amount}` : amount)
  if (moneyMinor(String(value), 2) !== (credit ? -minor : minor).toString()) throw new Error("Lossy JSON number")
  return value
}

export const economicProvider: AccountingProvider<EconomicSettings, EconomicDraft> = {
  id: "economic",
  map(event, settings) {
    const postings = postingsFor(event)
    if (!Array.isArray(postings)) return refuse(postings.code, postings.detail)
    const credit = event.type === "credit_note.issued"
    const parsed = credit ? creditNoteIssuedSchema.safeParse(event.payload) : invoiceIssuedSchema.safeParse(event.payload)
    if (!parsed.success || !("valuation" in parsed.data)) return refuse("not_postable", "Incomplete document")
    const p = parsed.data
    if (p.currency !== "DKK" || p.exponent !== 2 || p.valuation.base.currency !== "DKK" ||
        p.valuation.rateSource !== "same_currency" || p.valuation.rate !== "1" || p.calculation.version !== "v2")
      return refuse("unsupported_document", "Slice 1 supports same-currency DKK v2 documents")
    if (!event.deliveryId || ![settings.customerNumber, settings.layoutNumber, settings.paymentTermsNumber].every(n => Number.isSafeInteger(n) && n > 0))
      return refuse("missing_mapping", "Delivery, customer, layout and dueDate payment term are required")
    const name = p.buyer.company || p.buyer.name
    if (!name || name.length > 250 || !p.number || p.number.length > 250 || !p.lines.length)
      return refuse("unsupported_document", "Recipient, document reference or lines are missing or too long")
    const lines: EconomicDraft["lines"] = []
    const zones = new Set<number>()
    try {
      for (const line of p.lines) {
        const { treatment, rate } = line.vat
        if (!((treatment === "standard" && rate === "0.25") || (treatment === "intra_community" && rate === "0")))
          return refuse("unsupported_document", "VAT treatment or rate is outside slice 1")
        const mapping = settings.vatMappings[vatGroupKey(line.vat)]
        if (!mapping?.productNumber || mapping.productNumber.length > 25 || !Number.isSafeInteger(mapping.vatZoneNumber) || mapping.vatZoneNumber < 1)
          return refuse("missing_mapping", "Each frozen VAT group needs a product and VAT zone")
        zones.add(mapping.vatZoneNumber)
        // Preserve frozen line net rather than reprice original quantity/discount/inclusive inputs.
        const calculated = calculateDocument({ currency: "DKK", lines: [{ quantity: "1", unitPrice: line.net, sortOrder: 0, vat: line.vat }] })
        if (calculated.tax !== line.tax || calculated.gross !== line.gross || line.description.length > 2500)
          return refuse("unsupported_document", "Provider line rounding cannot reproduce frozen amounts")
        lines.push({ lineNumber: lines.length + 1, sortKey: lines.length + 1, description: line.description,
          product: { productNumber: mapping.productNumber }, quantity: credit ? -1 : 1, unitNetPrice: apiAmount(line.net, false) })
      }
      if (zones.size !== 1 || moneyMinor(p.totals.payableRounding, 2) !== "0" ||
          (["net", "tax", "gross", "payableRounding"] as const).some(k => p.totals[k] !== p.totals[`${k}Base`]))
        return refuse("unsupported_document", "Mixed VAT zones, rounding or base differences require reconciliation")
      const signed = (amount: string) => { apiAmount(amount, credit); return credit && moneyMinor(amount, 2) !== "0" ? `-${amount}` : amount }
      return { status: "prepared", idempotencyKey: event.deliveryId,
        expectedTotals: { net: signed(p.totals.net), tax: signed(p.totals.tax), gross: signed(p.totals.gross) },
        payload: { currency: p.currency, date: p.issueDate, dueDate: "dueDate" in p ? p.dueDate : p.issueDate,
          customer: { customerNumber: settings.customerNumber }, layout: { layoutNumber: settings.layoutNumber },
          paymentTerms: { paymentTermsNumber: settings.paymentTermsNumber }, recipient: { name, vatZone: { vatZoneNumber: [...zones][0]! } },
          references: { other: p.number }, lines } }
    } catch { return refuse("amount_not_representable", "Frozen money cannot be represented by this provider payload") }
  },
}

/** Build only after the worker has persisted the remotely created draft number. */
export function economicBookingPayload(draftInvoiceNumber: number) {
  if (!Number.isSafeInteger(draftInvoiceNumber) || draftInvoiceNumber < 1) throw new Error("Invalid draft number")
  return { draftInvoice: { draftInvoiceNumber }, sendBy: "none" as const }
}
