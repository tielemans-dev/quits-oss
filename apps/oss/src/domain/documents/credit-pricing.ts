import { Effect } from "effect"
import {
  buildCreditLines,
  computeCreditAvailability,
  type CreditableInvoiceLine,
  type CreditSelection,
} from "../../lib/credit-notes/calculation"
import { translate } from "../../lib/i18n/translate"
import { InvalidState, ValidationFailed } from "../errors"
import { documentFractionDigits, impliedTaxRate } from "./pricing"

/*
 * Prices a credit note against an invoice. The issue command and the approval a person reviews
 * before an agent's credit note is issued both use this, so the reviewer sees exactly what will
 * be credited.
 */

const num = (value: { toNumber(): number }) => value.toNumber()

type Decimalish = { toNumber(): number }
type CreditLineAmounts = {
  quantity: Decimalish
  lineNet: Decimalish
  lineTax: Decimalish
  lineGross: Decimalish
}

/** What is still creditable on an invoice, given its lines and issued credit notes. */
export function creditAvailabilityFor(invoice: {
  currency: string
  subtotalNet: Decimalish
  totalTax: Decimalish
  totalGross: Decimalish
  items: Array<
    CreditLineAmounts & {
      id: string
      description: string
      unitPriceNet: Decimalish
      unitPriceGross: Decimalish
      taxRate: Decimalish
      taxCategory: string
      taxCode: string | null
    }
  >
  creditNotes: Array<{
    subtotalNet: Decimalish
    totalTax: Decimalish
    totalGross: Decimalish
    items: Array<CreditLineAmounts & { invoiceItemId: string | null }>
  }>
}) {
  const lines: CreditableInvoiceLine[] = invoice.items.map((item) => ({
    id: item.id,
    description: item.description,
    quantity: num(item.quantity),
    unitPriceNet: num(item.unitPriceNet),
    unitPriceGross: num(item.unitPriceGross),
    lineNet: num(item.lineNet),
    lineTax: num(item.lineTax),
    lineGross: num(item.lineGross),
    taxRate: num(item.taxRate),
    taxCategory: item.taxCategory,
    taxCode: item.taxCode,
  }))
  const priorCredits = invoice.creditNotes.flatMap((creditNote) =>
    creditNote.items.map((item) => ({
      invoiceItemId: item.invoiceItemId,
      quantity: num(item.quantity),
      lineNet: num(item.lineNet),
      lineTax: num(item.lineTax),
      lineGross: num(item.lineGross),
    }))
  )
  const credited = (pick: (creditNote: (typeof invoice.creditNotes)[number]) => Decimalish) =>
    invoice.creditNotes.reduce((total, creditNote) => total + Math.round(num(pick(creditNote)) * 100), 0) /
    100

  return computeCreditAvailability({
    fractionDigits: documentFractionDigits(invoice.currency),
    lines,
    priorCredits,
    totalNet: num(invoice.subtotalNet),
    totalTax: num(invoice.totalTax),
    totalGross: num(invoice.totalGross),
    creditedNet: credited((creditNote) => creditNote.subtotalNet),
    creditedTax: credited((creditNote) => creditNote.totalTax),
    creditedGross: credited((creditNote) => creditNote.totalGross),
  })
}

/** The tax rate amount credits are priced at: the invoice's line rate, else its implied rate. */
export function creditTaxRate(invoice: {
  items: Array<{ taxRate: { toNumber(): number } }>
  subtotalNet: { toNumber(): number }
  totalTax: { toNumber(): number }
}) {
  const lineRate = invoice.items[0]?.taxRate.toNumber()
  return lineRate ?? Math.round(impliedTaxRate(invoice) * 100) / 100
}

type CreditableInvoice = Parameters<typeof creditAvailabilityFor>[0] & {
  status: string
  number: string
  locale: string
}

/**
 * The lines and totals of a credit note for `selection` on `invoice`. Fails when the invoice is
 * a draft or the selection credits more than is left.
 */
export const priceCreditNote = (invoice: CreditableInvoice, selection: CreditSelection) =>
  Effect.gen(function* () {
    if (invoice.status === "draft") {
      return yield* new InvalidState({
        message: "Only issued invoices can be credited",
        code: "invoice_not_issued",
      })
    }

    const built = buildCreditLines({
      availability: creditAvailabilityFor(invoice),
      selection,
      taxRate: creditTaxRate(invoice),
      amountDescription: translate("creditNotes.amountDescription", invoice.locale, {
        number: invoice.number,
      }),
    })
    if (!built.ok) {
      if (built.code === "amount_not_representable") {
        return yield* new ValidationFailed({
          message: built.message,
          issues: [{ path: "amount", message: built.message }],
        })
      }
      return yield* new InvalidState({ message: built.message, code: built.code })
    }
    return built
  })
