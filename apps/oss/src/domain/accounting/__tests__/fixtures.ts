import { calculateDocument, creditComponents } from "@quits/shared/pricing"
import type { CalculateDocumentInput } from "@quits/contracts/pricing"
import type { InvoiceIssued } from "../../events/money"
import type { PostingEvent, PostingRefusalCode } from "../postings"

export function invoiceFixture(input: Partial<CalculateDocumentInput> = {}): InvoiceIssued {
  const c = calculateDocument({ currency: "DKK", lines: [{ quantity: "1", unitPrice: "1", sortOrder: 0, vat: { treatment: "standard", rate: "0.25", country: "DK" } }], ...input })
  return {
    documentId: "invoice", number: "INV-1", purpose: "sale", occurredAt: "2026-10-07T12:00:00.000Z",
    postingDate: "2026-10-07", issueDate: "2026-10-07", taxPointDate: "2026-10-07", taxPointReason: "invoice_issued",
    supplyDate: "2026-10-07", dueDate: "2026-11-07", currency: c.currency, exponent: c.calculation.exponent,
    valuation: { base: { minor: c.debtorBase.replace(".", ""), currency: c.baseCurrency, exponent: c.calculation.baseExponent }, rate: c.exchangeRate, rateScale: 0, rateDate: "2026-10-07", rateSource: c.currency === c.baseCurrency ? "same_currency" : "user" },
    lines: c.lines.map((l, i) => ({ lineId: `line-${i}`, description: "Work", quantityInput: l.quantity, unitPriceInput: l.unitPrice, net: l.net, tax: l.tax, gross: l.gross, vat: l.vat })),
    vatGroups: c.groups, totals: { net: c.net, tax: c.tax, gross: c.gross, payableRounding: c.payableRounding, netBase: c.netBase, taxBase: c.taxBase, grossBase: c.debtorBase, payableRoundingBase: c.payableRoundingBase },
    calculation: c.calculation, seller: { taxIds: [{ scheme: "VAT", value: "DK12345678" }] }, buyer: { country: "US", taxIds: [{ scheme: "VAT", value: "DE123456789" }] },
    coveredByAdvances: [], depositApplications: [], artifacts: { pdf: { ref: "fixture.pdf", hash: "a".repeat(64), size: 10 } },
    provenance: { agreementId: null, quoteId: null, recurringInvoiceId: null, candidateId: "candidate", commandId: null },
  }
}
export function creditFixture() {
  const invoice = invoiceFixture(), g = invoice.vatGroups[0]!
  const c = creditComponents({ group: g as Parameters<typeof creditComponents>[0]["group"], cumulativeBefore: "0", creditedGross: g.gross })
  const { purpose: _purpose, dueDate: _dueDate, coveredByAdvances: _advances, depositApplications: _applications, ...rest } = invoice
  return { ...rest, documentId: "credit", correctsInvoiceId: invoice.documentId, correctsNumber: invoice.number, correctsPurpose: "sale", mode: "amount", reason: "Correction",
    creditedGroups: [{ original: g, creditedGross: c.gross, creditedTax: c.tax, creditedNet: c.net, creditedRounding: c.payableRounding,
      cumulativeBefore: "0.00", cumulativeAfter: c.gross, cumulativeTaxBefore: "0.00", cumulativeTaxAfter: c.tax, cumulativeRoundingBefore: "0.00", cumulativeRoundingAfter: c.payableRounding,
      remainingGross: "0.00", remainingTax: "0.00", remainingNet: "0.00", remainingRounding: "0.00", grossBase: c.grossBase, netBase: c.netBase, taxBase: c.taxBase, payableRoundingBase: c.payableRoundingBase }],
    historicalReversal: [{ key: g.key, revenueBase: c.netBase, taxBase: c.taxBase, roundingBase: c.payableRoundingBase }],
    debtorDischarge: { quantity: { minor: "125", currency: "DKK", exponent: 2 }, carryingBase: c.grossBase, valuationSource: "frozen_components" },
    customerCreditCreated: null, allocationsReleased: [], fxDifferenceBase: "0.00", postable: true }
}
const invoice = (change: (p: InvoiceIssued) => void): PostingEvent => { const p = invoiceFixture(); change(p); return { type: "invoice.issued", schemaVersion: 1, payload: p } }
const credit = (change: (p: ReturnType<typeof creditFixture>) => void): PostingEvent => { const p = creditFixture(); change(p); return { type: "credit_note.issued", schemaVersion: 2, payload: p } }
const evidence = { buyerVatId: "DE123456789", viesCheck: { at: "2026-10-07T12:00:00.000Z", result: "valid" as const }, statementText: "Reverse charge" }
const intra = (): InvoiceIssued => invoiceFixture({ lines: [{ quantity: "1", unitPrice: "1", sortOrder: 0, vat: { treatment: "intra_community", reasonCode: "services_b2b", rate: "0", country: "DE" }, evidence }] })
const intraCase = (change: (p: InvoiceIssued) => void): PostingEvent => { const p = intra(); change(p); return { type: "invoice.issued", schemaVersion: 1, payload: p } }
export const refusalFixtures: Array<{ name: string; code: PostingRefusalCode; event: PostingEvent }> = [
  { name: "unknown valuation", code: "base_valuation_unknown", event: invoice(p => { p.valuation.rateSource = "unknown" }) },
  { name: "absent valuation", code: "base_valuation_unknown", event: { type: "invoice.issued", schemaVersion: 1, payload: { number: "Legacy" } } },
  { name: "unknown components", code: "base_valuation_unknown", event: invoice(p => { p.totals.netBase = null }) },
  { name: "legacy currency", code: "not_postable", event: invoice(p => { p.currency = "BHD" }) },
  { name: "sparse v1", code: "not_postable", event: { type: "credit_note.issued", schemaVersion: 1, payload: { number: "Old" } } },
  ...["allocations_pending", "purpose_not_supported", "balance_adjustment_unsupported", "historical_payload_incomplete"].map(reason => ({ name: `incomplete ${reason}`, code: "not_postable" as const, event: credit(p => { Object.assign(p, { postable: false, incompleteReason: reason }) }) })),
  ...["tax_point_review", "assessment_required", "none"].map(reason => ({ name: reason, code: "tax_point_review_required" as const, event: invoice(p => { Object.assign(p, { taxPointReason: reason }) }) })),
  { name: "tax date mismatch", code: "tax_point_review_required", event: invoice(p => { p.taxPointDate = "2026-10-06" }) },
  { name: "earlier supply", code: "tax_point_review_required", event: invoice(p => { p.supplyDate = "2026-10-06" }) },
  { name: "null supply", code: "tax_point_review_required", event: invoice(p => { p.supplyDate = null }) },
  ...["unclassified_zero", "zero_rated", "reverse_charge_domestic"].map(treatment => ({ name: treatment, code: "unsupported_treatment_combination" as const, event: invoice(p => { Object.assign(p.vatGroups[0]!, { treatment, rate: "0" }) }) })),
  { name: "mixed out of scope", code: "unsupported_treatment_combination", event: invoice(p => { p.vatGroups.push({ ...p.vatGroups[0]!, treatment: "out_of_scope", rate: "0", key: "other" }) }) },
  { name: "standard zero rate", code: "unsupported_treatment_combination", event: invoice(p => { p.vatGroups[0]!.rate = "0" }) },
  { name: "services nonzero rate (4c)", code: "unsupported_treatment_combination", event: intraCase(p => { p.vatGroups[0]!.rate = "0.25" }) },
  ...["buyerVatId", "viesCheck", "statementText"].map(field => ({ name: `missing ${field}`, code: "unsupported_treatment_combination" as const, event: intraCase(p => { delete (p.vatGroups[0]!.evidence as Record<string, unknown>)[field] }) })),
  { name: "missing seller VAT", code: "unsupported_treatment_combination", event: intraCase(p => { p.seller.taxIds = [] }) },
  ...["invalid", "unavailable"].map(result => ({ name: `VIES ${result}`, code: "unsupported_treatment_combination" as const, event: intraCase(p => { Object.assign(p.vatGroups[0]!.evidence!.viesCheck!, { result }) }) })),
  ...["export no reference", "export EU buyer", "exempt no reason"].map(name => {
    const p = invoiceFixture({ lines: [{ quantity: "1", unitPrice: "1", sortOrder: 0, vat: { treatment: name.startsWith("export") ? "export" : "exempt", reasonCode: name.startsWith("export") ? "goods_outside_eu" : "other", rate: "0" }, evidence: name.startsWith("export") ? { exportEvidence: { kind: "other", ref: "customs" } } : { statementText: "Exemption" } }] })
    if (name === "export no reference") p.vatGroups[0]!.evidence!.exportEvidence!.ref = ""
    if (name === "export EU buyer") p.buyer.country = "DE"
    if (name === "exempt no reason") p.vatGroups[0]!.evidence = {}
    return { name, code: "unsupported_treatment_combination" as const, event: { type: "invoice.issued", schemaVersion: 1, payload: p } }
  }),
  { name: "prepayment", code: "purpose_not_supported", event: invoice(p => { p.purpose = "prepayment" }) },
  { name: "credit corrects prepayment", code: "purpose_not_supported", event: credit(p => { p.correctsPurpose = "prepayment" }) },
  { name: "covered advance", code: "advances_not_supported", event: invoice(p => { Object.assign(p, { coveredByAdvances: [{}] }) }) },
  { name: "advance tax point", code: "advances_not_supported", event: invoice(p => { p.taxPointReason = "advance_received" }) },
  { name: "deposit application", code: "applications_not_supported", event: invoice(p => { Object.assign(p, { depositApplications: [{}] }) }) },
  { name: "allocation release", code: "applications_not_supported", event: credit(p => { Object.assign(p, { allocationsReleased: [{}] }) }) },
  { name: "customer credit", code: "applications_not_supported", event: credit(p => { Object.assign(p, { customerCreditCreated: {} }) }) },
  { name: "document equation", code: "equation_violation", event: invoice(p => { p.vatGroups[0]!.net = "1.01" }) },
  { name: "base equation", code: "equation_violation", event: invoice(p => { p.vatGroups[0]!.netBase = "1.01" }) },
  { name: "sub-minor component", code: "equation_violation", event: invoice(p => { p.vatGroups[0]!.netBase = "1.001" }) },
  { name: "discharge imbalance", code: "equation_violation", event: credit(p => { p.debtorDischarge.carryingBase = "1.26" }) },
  { name: "FX bridge", code: "equation_violation", event: credit(p => { p.fxDifferenceBase = "0.01" }) },
  ...["payment.recorded", "payment.voided", "deposit.received", "credit_note.allocations_reconciled", "fee.assessed", "unknown"].map(type => ({ name: type, code: "event_not_supported" as const, event: { type, schemaVersion: 1, payload: {} } })),
]
