import { moneyMinor, percentageToFraction, valueFrozenGroups } from "@quits/shared/pricing"
import { requireCurrencyExponent } from "@quits/shared/currency"
import type { Prisma, Invoice, InvoiceItem } from "../../../generated/prisma/client"
import type { BuyerSnapshot, SellerSnapshot } from "@quits/contracts/documents"
import type { InvoiceIssued } from "../events/money"
import { toDecimal, formatIsoDate } from "../../lib/exports/format"
import { frozenVatGroups } from "./frozen-vat-groups"
import { InvalidState } from "../errors"

export type InvoiceMoneySnapshot = Omit<InvoiceIssued, "artifacts" | "provenance"> & { provenance: Omit<InvoiceIssued["provenance"], "candidateId" | "commandId"> }
export function invoiceMoneySnapshot(invoice: Invoice & { items: InvoiceItem[] }, input: {
  issuedAt: Date; baseCurrency: string; supplyDate?: string; exchangeRate?: string; rateDate?: string;
  vatReporting?: InvoiceIssued["vatReporting"]; seller: SellerSnapshot; buyer: BuyerSnapshot;
}): InvoiceMoneySnapshot {
  const exponent = requireCurrencyExponent(invoice.currency)
  const baseExponent = requireCurrencyExponent(input.baseCurrency)
  const same = invoice.currency === input.baseCurrency
  if (!same && (!input.exchangeRate || !input.rateDate)) throw new InvalidState({ code: "base_valuation_required", message: "Confirm an exchange rate and rate date in the organization's base currency" })
  const rate = same ? "1" : input.exchangeRate!
  if (same && input.exchangeRate && !toDecimal(input.exchangeRate).eq(1)) throw new InvalidState({ code: "invalid_exchange_rate", message: "Same-currency rate must be one" })
  const groups = valueFrozenGroups(frozenVatGroups(invoice), input.baseCurrency, rate)
  const sum = (field: keyof (typeof groups)[number]) => groups.reduce((total, group) => total.plus(String(group[field])), toDecimal(0)).toFixed(field.toString().endsWith("Base") ? baseExponent : exponent)
  const issueDate = formatIsoDate(input.issuedAt, invoice.timezone)
  const supplyDate = input.supplyDate ? input.supplyDate.slice(0, 10) : invoice.supplyDate ? invoice.supplyDate.toISOString().slice(0, 10) : null
  const reviewed = !supplyDate || supplyDate < issueDate
  return {
    documentId: invoice.id, number: invoice.number, purpose: invoice.purpose,
    occurredAt: input.issuedAt.toISOString(), postingDate: issueDate, issueDate,
    taxPointDate: reviewed ? null : issueDate, taxPointReason: reviewed ? "tax_point_review" : "invoice_issued",
    supplyDate, dueDate: formatIsoDate(invoice.dueDate, invoice.timezone), currency: invoice.currency, exponent,
    valuation: { base: { minor: moneyMinor(sum("grossBase"), baseExponent), currency: input.baseCurrency, exponent: baseExponent }, rate, rateScale: rate.split(".")[1]?.length ?? 0, rateDate: same ? issueDate : input.rateDate!, rateSource: same ? "same_currency" : "user" },
    ...(input.vatReporting ? { vatReporting: input.vatReporting } : {}),
    lines: invoice.items.map(line => ({ lineId: line.id, description: line.description,
      quantityInput: line.quantityInput ?? line.quantity.toString(), unitPriceInput: line.unitPriceInput ?? (invoice.pricesIncludeTax ? line.unitPriceGross : line.unitPriceNet).toString(),
      net: line.lineNet.toFixed(exponent), tax: line.lineTax.toFixed(exponent), gross: line.lineGross.toFixed(exponent),
      vat: { treatment: line.vatTreatment as InvoiceIssued["lines"][number]["vat"]["treatment"], rate: line.vatRateInput ?? percentageToFraction(line.taxRate.toString()), country: line.vatCountry, reasonCode: line.vatReasonCode as InvoiceIssued["lines"][number]["vat"]["reasonCode"] }, deliverableId: line.deliverableId })),
    vatGroups: groups, totals: { net: sum("net"), tax: sum("tax"), gross: sum("gross"), payableRounding: sum("payableRounding"), netBase: sum("netBase"), taxBase: sum("taxBase"), grossBase: sum("grossBase"), payableRoundingBase: sum("payableRoundingBase") },
    calculation: { version: invoice.calculationVersion as "v2" | "legacy_per_line", roundingMode: "half_up", pricesIncludeTax: invoice.pricesIncludeTax, exponent, baseExponent },
    seller: input.seller, buyer: input.buyer, coveredByAdvances: [], depositApplications: [],
    provenance: { agreementId: invoice.agreementId, quoteId: invoice.quoteId, recurringInvoiceId: invoice.recurringInvoiceId },
  }
}
export const jsonSnapshot = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

export function creditMoneySnapshot(invoice: Invoice, note: {
  id: string; number: string; issuedAt: Date; baseCurrency: string; reason: string; mode: "full" | "lines" | "amount";
  built: Extract<ReturnType<typeof import("../../lib/credit-notes/calculation").buildCreditLines>, { ok: true }>;
  hasPayments: boolean; paid: string; priorCredits: string; seller: SellerSnapshot; buyer: BuyerSnapshot;
}) {
  const original = invoice.issuanceSnapshot as InvoiceIssued | null
  const exponent = requireCurrencyExponent(invoice.currency)
  const baseCurrency = original?.valuation.base.currency ?? note.baseCurrency
  const baseExponent = requireCurrencyExponent(baseCurrency)
  const groups = note.built.creditedGroups ?? []
  const sum = (field: "netBase" | "taxBase" | "grossBase" | "payableRoundingBase") => groups.length && groups.every(group => group[field] !== null)
    ? groups.reduce((total, group) => total.plus(group[field]!), toDecimal(0)).toFixed(baseExponent) : null
  const grossBase = sum("grossBase")
  const unknown = !original || original.valuation.rateSource === "unknown" || grossBase === null
  const open = toDecimal(invoice.totalGross.toString()).minus(note.paid).minus(note.priorCredits)
  const unsupportedBalance = toDecimal(note.built.totalGross).gt(open) || unknown
  const allocations = note.hasPayments || !!original?.coveredByAdvances.length || !!original?.depositApplications.length
  const incompleteReason = invoice.purpose !== "sale" ? "purpose_not_supported" : allocations ? "allocations_pending" : unsupportedBalance ? "balance_adjustment_unsupported" : undefined
  const issueDate = formatIsoDate(note.issuedAt, invoice.timezone)
  const valuation = unknown ? { base: { minor: null, currency: baseCurrency, exponent: baseExponent }, rate: null, rateScale: null, rateDate: null, rateSource: "unknown" }
    : { ...original.valuation, base: { ...original.valuation.base, minor: moneyMinor(grossBase!, baseExponent) } }
  return {
    documentId: note.id, number: note.number, occurredAt: note.issuedAt.toISOString(), postingDate: issueDate, issueDate,
    taxPointDate: original?.taxPointReason === "invoice_issued" ? issueDate : null,
    taxPointReason: original?.taxPointReason ?? "tax_point_review", supplyDate: original?.supplyDate ?? null,
    currency: invoice.currency, exponent, valuation,
    lines: note.built.lines.map((line, index) => ({ lineId: `${note.id}:${index}`, description: line.description,
      quantityInput: String(line.quantity), unitPriceInput: String(invoice.pricesIncludeTax ? line.unitPriceGross : line.unitPriceNet),
      net: toDecimal(line.lineNet).toFixed(exponent), tax: toDecimal(line.lineTax).toFixed(exponent), gross: toDecimal(line.lineGross).toFixed(exponent),
      vat: { treatment: line.vatTreatment ?? line.taxCategory, country: line.vatCountry ?? null, reasonCode: line.vatReasonCode ?? null, rate: line.vatRateInput ?? percentageToFraction(String(line.taxRate)) } })),
    vatGroups: groups.map(group => ({ ...group.original, net: group.creditedNet, tax: group.creditedTax, gross: group.creditedGross, payableRounding: group.creditedRounding, netBase: group.netBase, taxBase: group.taxBase, grossBase: group.grossBase, payableRoundingBase: group.payableRoundingBase })),
    totals: { net: toDecimal(note.built.subtotalNet).toFixed(exponent), tax: toDecimal(note.built.totalTax).toFixed(exponent), gross: toDecimal(note.built.totalGross).toFixed(exponent), payableRounding: toDecimal(note.built.payableRounding ?? 0).toFixed(exponent), netBase: sum("netBase"), taxBase: sum("taxBase"), grossBase, payableRoundingBase: sum("payableRoundingBase") },
    calculation: { version: invoice.calculationVersion, roundingMode: "half_up", pricesIncludeTax: invoice.pricesIncludeTax, exponent, baseExponent },
    seller: note.seller, buyer: note.buyer,
    provenance: { agreementId: invoice.agreementId, quoteId: invoice.quoteId, recurringInvoiceId: invoice.recurringInvoiceId },
    correctsInvoiceId: invoice.id, correctsNumber: invoice.number, correctsPurpose: invoice.purpose,
    mode: note.mode === "amount" ? "amount" : "lines", reason: note.reason, creditedGroups: groups,
    historicalReversal: groups.map(group => ({ key: group.original.key, revenueBase: group.netBase, taxBase: group.taxBase, roundingBase: group.payableRoundingBase })),
    debtorDischarge: { quantity: { minor: moneyMinor(String(note.built.totalGross), exponent), currency: invoice.currency, exponent }, carryingBase: incompleteReason ? null : grossBase, valuationSource: incompleteReason ? "unknown" : "frozen_components" },
    customerCreditCreated: null, allocationsReleased: allocations ? null : [], fxDifferenceBase: incompleteReason ? null : toDecimal(0).toFixed(baseExponent),
    postable: !incompleteReason, ...(incompleteReason ? { incompleteReason } : {}),
  }
}
