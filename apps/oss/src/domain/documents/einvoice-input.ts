import { vatGroupKey, percentageToFraction } from "@quits/shared/pricing"
import { buildBuyerParty, buildEinvoicePayment, buildSellerParty } from "../../lib/exports/einvoice"
import type { EinvoiceDocument } from "../../lib/exports/ubl"
import type { InvoiceMoneySnapshot } from "./money-snapshot"

/** A complete frozen UBL render input. Publication never consults current party records. */
export function frozenEinvoiceInput(input: {
  kind: "invoice" | "creditNote";
  money: Pick<InvoiceMoneySnapshot, "number" | "issueDate" | "supplyDate" | "currency" | "buyer" | "seller" | "calculation" | "vatGroups" | "totals">;
  contact: Parameters<typeof buildBuyerParty>[1];
  countryCode: string; dueDate: string | null; orderReference: string | null;
  billingReference: EinvoiceDocument["billingReference"]; note: string | null;
  lines: Array<{ description: string; quantity: string; unitPriceNet: string; lineNet: string; taxRate: string; taxCategory: string; vatTreatment?: string; vatCountry?: string | null; vatReasonCode?: string | null; vatRateInput?: string | null }>;
}): EinvoiceDocument {
  const buyer = buildBuyerParty(input.money.buyer, input.contact)
  const payment = input.kind === "invoice" ? buildEinvoicePayment(input.money.seller.bankAccount, input.money.number) : null
  return {
    kind: input.kind, issued: true, calculationVersion: input.money.calculation.version,
    frozenGroups: input.money.vatGroups, number: input.money.number, issueDate: input.money.issueDate,
    dueDate: input.dueDate, deliveryDate: input.money.supplyDate, currency: input.money.currency,
    buyerReference: input.orderReference || buyer.name, orderReference: input.orderReference,
    billingReference: input.billingReference, note: input.note,
    seller: buildSellerParty({ snapshot: input.money.seller, settings: null, taxIds: [], documentCountryCode: input.countryCode }), buyer,
    // Left out entirely without an IBAN, so documents of organizations without payment details hash as before.
    ...(payment ? { payment } : {}),
    lines: input.lines.map(line => ({ ...line, groupKey: vatGroupKey({ treatment: line.vatTreatment ?? line.taxCategory, country: line.vatCountry ?? null, reasonCode: line.vatReasonCode ?? null, rate: line.vatRateInput ?? percentageToFraction(line.taxRate) }) })), storedGross: input.money.totals.gross, amountPaid: "0",
  }
}
