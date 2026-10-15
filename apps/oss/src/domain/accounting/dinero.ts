import { z } from "zod"
import { calculateDocument, moneyMinor, vatGroupKey } from "@quits/shared/pricing"
import { creditNoteIssuedSchema, invoiceIssuedSchema } from "../events/money"
import { eventRegistry } from "../events/registry"
import { apiAmount } from "./api-amount"
import { postingsFor } from "./postings"
import type { AccountingEvent, AccountingProvider, AccountingRefusal } from "./provider"

const account = z.number().int().positive().max(2147483647)
// Caller-supplied immutable evidence, pinned to this payment. Never derive from today's rows/date.
const paymentEvidence = z.strictObject({ paymentId: z.string().min(1), invoiceNumber: z.string().min(1),
  invoiceGuid: z.guid(), timestamp: z.string().trim().min(1), depositAccountNumber: account,
  paymentDate: z.iso.date(), baseAmount: z.string(), settlement: z.literal("gross_no_fees") })
export type DineroSettings = {
  contactGuid: string
  documentGuid: string // Stable UUID persisted before creating a draft.
  invoiceLinks: Record<string, string> // Quits invoice ID -> booked Dinero invoice GUID.
  vatMappings: Record<string, { accountNumber: number }> // Account's VAT type must match the frozen group.
  payment?: z.infer<typeof paymentEvidence>
}
type ProductLine = { Description: string; AccountNumber: number; Quantity: number; BaseAmountValue: number; Discount: 0; Unit: "parts"; LineType: "Product" }
type Draft = { Guid: string; ContactGuid: string; Currency: string; Date: string; ExternalReference: string; Comment: string;
  ShowLinesInclVat: false; ProductLines: ProductLine[] } & (
  { CreditNoteFor: string } | { PaymentConditionType: "Netto"; PaymentConditionNumberOfDays: number })
type Payment = { Timestamp: string; DepositAccountNumber: number; PaymentDate: string; Amount: number;
  RemainderIsFee: false; Description: string; ExternalReference: string }
type DineroPayload = { path: "/invoices" | "/sales/creditnotes"; body: Draft } | { path: `/invoices/${string}/payments`; body: Payment }
const refuse = (code: string, detail: string): AccountingRefusal => ({ status: "refused", code, detail })

function preparePayment(event: AccountingEvent, settings: DineroSettings) {
  const parsed = eventRegistry["payment.recorded"].schema.safeParse(event.payload)
  if (event.schemaVersion !== 1 || !parsed.success) return refuse("not_postable", "Unsupported or incomplete payment")
  const p = parsed.data, evidence = paymentEvidence.safeParse(settings.payment)
  if (!evidence.success || evidence.data.paymentId !== p.paymentId || evidence.data.invoiceNumber !== p.number)
    return refuse("missing_mapping", "Payment needs matching frozen evidence and a booked invoice link")
  const e = evidence.data
  try {
    if (p.currency !== "DKK" || moneyMinor(p.amount, 2) === "0" || moneyMinor(p.amount, 2) !== moneyMinor(e.baseAmount, 2) ||
        BigInt(moneyMinor(p.balanceDue, 2)) < 0n || moneyMinor(p.overpaidBy ?? "0", 2) !== "0")
      return refuse("unsupported_payment", "Only positive same-currency DKK gross receipts without fees or overpayment")
    const amount = apiAmount(p.amount)
    const payload: DineroPayload = { path: `/invoices/${e.invoiceGuid}/payments`, body: { Timestamp: e.timestamp,
      DepositAccountNumber: e.depositAccountNumber, PaymentDate: e.paymentDate, Amount: amount,
      RemainderIsFee: false, Description: p.number, ExternalReference: event.deliveryId } }
    return { status: "prepared" as const, idempotencyKey: event.deliveryId, payload,
      expectedTotals: { net: "0.00", tax: "0.00", gross: p.amount } }
  } catch { return refuse("amount_not_representable", "Payment money cannot be represented by this provider payload") }
}

/** Pure request preparation. Official request models are linked in docs/accounting-integrations.md. */
export const dineroProvider: AccountingProvider<DineroSettings, DineroPayload> = {
  id: "dinero",
  map(event, settings) {
    if (!event.deliveryId || event.deliveryId.length > 128) return refuse("missing_mapping", "Delivery reference must fit ExternalReference")
    if (event.type === "payment.recorded") return preparePayment(event, settings)
    const postings = postingsFor(event)
    if (!Array.isArray(postings)) return refuse(postings.code, postings.detail)
    const credit = event.type === "credit_note.issued"
    const parsed = credit ? creditNoteIssuedSchema.safeParse(event.payload) : invoiceIssuedSchema.safeParse(event.payload)
    if (!parsed.success || !("valuation" in parsed.data)) return refuse("not_postable", "Incomplete document")
    const p = parsed.data
    if (p.currency !== "DKK" || p.exponent !== 2 || p.valuation.base.currency !== "DKK" ||
        p.valuation.rateSource !== "same_currency" || p.valuation.rate !== "1" || p.calculation.version !== "v2")
      return refuse("unsupported_document", "Only same-currency DKK v2 documents")
    const originalGuid = "correctsInvoiceId" in p ? settings.invoiceLinks[p.correctsInvoiceId] : undefined
    if (!z.guid().safeParse(settings.contactGuid).success || !z.guid().safeParse(settings.documentGuid).success ||
        (credit && !z.guid().safeParse(originalGuid).success)) return refuse("missing_mapping", "Contact, stable draft and corrected invoice GUIDs are required")
    if (!p.lines.length || !p.number) return refuse("unsupported_document", "Document reference and lines are required")
    const days = "dueDate" in p ? (Date.parse(p.dueDate) - Date.parse(p.issueDate)) / 86400000 : 0
    if (!Number.isSafeInteger(days) || days < 0) return refuse("unsupported_document", "Due date cannot precede issue date")
    try {
      const lines: ProductLine[] = []
      for (const line of p.lines) {
        const { treatment, rate } = line.vat
        if (!((treatment === "standard" && rate === "0.25") || (treatment === "intra_community" && rate === "0")))
          return refuse("unsupported_document", "Unsupported VAT treatment or rate")
        const mapping = settings.vatMappings[vatGroupKey(line.vat)]
        if (!account.safeParse(mapping?.accountNumber).success) return refuse("missing_mapping", "Each frozen VAT group needs an entry account")
        const calculated = calculateDocument({ currency: "DKK", lines: [{ quantity: "1", unitPrice: line.net, sortOrder: 0, vat: line.vat }] })
        if (!line.description || calculated.tax !== line.tax || calculated.gross !== line.gross)
          return refuse("unsupported_document", "Provider line rounding cannot reproduce frozen amounts")
        // Dedicated credit-note endpoint reverses positive amounts. Never negate a second time.
        lines.push({ Description: line.description, AccountNumber: mapping!.accountNumber, Quantity: 1,
          BaseAmountValue: apiAmount(line.net), Discount: 0, Unit: "parts", LineType: "Product" })
      }
      if (moneyMinor(p.totals.payableRounding, 2) !== "0" ||
          (["net", "tax", "gross", "payableRounding"] as const).some(k => p.totals[k] !== p.totals[`${k}Base`]))
        return refuse("unsupported_document", "Rounding or base differences require reconciliation")
      const signed = (amount: string) => { apiAmount(amount, credit); return credit && moneyMinor(amount, 2) !== "0" ? `-${amount}` : amount }
      return { status: "prepared", idempotencyKey: event.deliveryId,
        expectedTotals: { net: signed(p.totals.net), tax: signed(p.totals.tax), gross: signed(p.totals.gross) },
        payload: { path: credit ? "/sales/creditnotes" : "/invoices", body: { Guid: settings.documentGuid, ContactGuid: settings.contactGuid,
          Currency: p.currency, Date: p.issueDate, ExternalReference: event.deliveryId, Comment: p.number, ShowLinesInclVat: false, ProductLines: lines,
          ...("correctsInvoiceId" in p ? { CreditNoteFor: originalGuid! } : { PaymentConditionType: "Netto" as const, PaymentConditionNumberOfDays: days }) } } }
    } catch { return refuse("amount_not_representable", "Frozen money cannot be represented by this provider payload") }
  },
}

/** Booking requires the version returned by creation/read, not a wall-clock timestamp. */
export function dineroBookingPayload(timestamp: string) {
  if (!timestamp.trim()) throw new Error("Missing Dinero timestamp")
  return { Timestamp: timestamp }
}
