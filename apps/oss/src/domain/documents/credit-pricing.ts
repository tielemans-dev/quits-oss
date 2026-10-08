import { issuedNumber } from "./numbering"
import { creditedGroupsSchema } from "@quits/contracts/pricing"
import { vatGroupKey, percentageToFraction } from "@quits/shared/pricing"
import { frozenVatGroups } from "./frozen-vat-groups"
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
  calculationVersion?: string
  vatEvidence?: unknown
  issuanceSnapshot?: unknown
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
      vatTreatment?: string
      vatReasonCode?: string | null
      vatCountry?: string | null
      vatRateInput?: string | null
    }
  >
  creditNotes: Array<{
    creditedGroups?: unknown
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
    ...(invoice.calculationVersion === "v2" ? {
      vatRateInput: item.vatRateInput, vatTreatment: item.vatTreatment, vatCountry: item.vatCountry, vatReasonCode: item.vatReasonCode,
      groupKey: vatGroupKey({ treatment: item.vatTreatment!, reasonCode: item.vatReasonCode, country: item.vatCountry, rate: item.vatRateInput ?? percentageToFraction(String(num(item.taxRate))) }),
    } : {}),
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

  const availability = computeCreditAvailability({
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
  if (invoice.calculationVersion === "v2") {
    const recorded = (invoice.issuanceSnapshot as { vatGroups?: import("@quits/contracts/pricing").FrozenVatGroup[] } | null)?.vatGroups
    const groups = recorded ?? frozenVatGroups({ currency: invoice.currency, vatEvidence: invoice.vatEvidence,
      items: invoice.items.map((item) => ({ ...item, vatTreatment: item.vatTreatment!, vatReasonCode: item.vatReasonCode ?? null, vatCountry: item.vatCountry ?? null })) })
    const prior = invoice.creditNotes.flatMap((credit) => creditedGroupsSchema.parse(credit.creditedGroups))
    availability.groups = groups.map((original) => {
      const matches = prior.filter((group) => group.original.key === original.key)
      const sum = (pick: (group: (typeof matches)[number]) => string) =>
        String(matches.reduce((sum, group) => sum + Math.round(Number(pick(group)) * 100), 0) / 100)
      return { original, creditedGross: sum((g) => g.creditedGross), creditedTax: sum((g) => g.creditedTax), creditedRounding: sum((g) => g.creditedRounding) }
    })
  }
  return availability
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
  number: string | null
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

    const built = yield* Effect.try({ try: () => buildCreditLines({
      availability: creditAvailabilityFor(invoice),
      selection,
      taxRate: creditTaxRate(invoice),
      amountDescription: translate("creditNotes.amountDescription", invoice.locale, {
        number: issuedNumber(invoice),
      }),
    }), catch: () => new InvalidState({ code: "credit_groups_unavailable", message: "The invoice lacks valid frozen credit groups or prior credit components" }) })
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
