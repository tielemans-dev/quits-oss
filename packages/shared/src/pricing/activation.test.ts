import { describe, expect, it } from "vitest"
import { calculateDraft, previewDraft, validateVatIssuance } from "./index"
import { invoiceCreateDraftV2InputSchema, invoiceCreateDraftInputSchema } from "@quits/contracts/invoices"
import { quoteCreateDraftV2InputSchema } from "@quits/contracts/quotes"
import { recurringCreateV2InputSchema } from "@quits/contracts/recurring"
import { agreementCreateDraftDecimalInputSchema } from "@quits/contracts/agreements"

const evidence = { buyerVatId: "DE123456789", viesCheck: { at: "2026-10-07T10:00:00Z", result: "valid" as const }, statementText: "Reverse charge" }
const intra = { treatment: "intra_community", rate: "0", reasonCode: "goods", country: "DE" }
const valid = { lines: [intra], sellerVatId: "DK12345678", buyerCountry: "DE", evidence }

describe("VAT issuance validation", () => {
  it.each(["goods", "services_b2b"])("accepts evidenced intra-community %s", (reasonCode) => {
    expect(validateVatIssuance({ ...valid, lines: [{ ...intra, reasonCode }] })).toEqual([])
  })
  it.each([
    { evidence: {} }, { sellerVatId: "" }, { evidence: { ...evidence, buyerVatId: " " } },
    { evidence: { ...evidence, statementText: " " } },
    { evidence: { ...evidence, viesCheck: { ...evidence.viesCheck, result: "invalid" } } },
    { evidence: { ...evidence, viesCheck: { ...evidence.viesCheck, result: "unavailable" } } },
    { evidence: { ...evidence, viesCheck: { result: "valid" } } },
  ])("refuses missing identifiers, statement or valid VIES: %j", (changes) => {
    expect(validateVatIssuance({ ...valid, ...changes }).length).toBeGreaterThan(0)
  })
  it.each(["reverse_charge_domestic", "zero_rated", "unclassified_zero"])("refuses Phase A treatment %s", (treatment) => {
    expect(validateVatIssuance({ ...valid, lines: [{ treatment, rate: "0", reasonCode: treatment === "reverse_charge_domestic" ? "construction" : null }] })).toContain(`${treatment} is refused in Phase A`)
  })
  it("enforces reason codes, zero rates, standard positive rate and out-of-scope exclusivity", () => {
    for (const line of [
      { treatment: "standard", rate: "0" }, { treatment: "exempt", reasonCode: "financial", rate: "0.25" },
      { treatment: "intra_community", reasonCode: "health", rate: "0" },
    ]) expect(validateVatIssuance({ ...valid, lines: [line] }).length).toBeGreaterThan(0)
    expect(validateVatIssuance({ ...valid, lines: [{ treatment: "out_of_scope", rate: "0" }, { treatment: "standard", rate: "0.25" }] })).toContain("out_of_scope cannot mix with other treatments")
    expect(validateVatIssuance({ ...valid, lines: [{ treatment: "out_of_scope", rate: "0" }] })).toEqual([])
  })
  it("accepts an exemption with reason text and refuses it without", () => {
    const lines = [{ treatment: "exempt", rate: "0", reasonCode: "health" }]
    expect(validateVatIssuance({ ...valid, lines, evidence: { statementText: "Health exemption" } })).toEqual([])
    expect(validateVatIssuance({ ...valid, lines, evidence: {} }).length).toBeGreaterThan(0)
  })
  it.each(["customs_declaration", "carrier_document", "other"])("requires export %s reference and non-EU buyer country", (kind) => {
    const input = { lines: [{ treatment: "export", rate: "0", reasonCode: "goods_outside_eu" }], evidence: { exportEvidence: { kind, ref: "REF-123" } }, buyerCountry: "US" }
    expect(validateVatIssuance(input)).toEqual([])
    expect(validateVatIssuance({ ...input, buyerCountry: "DK" }).length).toBeGreaterThan(0)
    expect(validateVatIssuance({ ...input, buyerCountry: null }).length).toBeGreaterThan(0)
    expect(validateVatIssuance({ ...input, evidence: { exportEvidence: { kind, ref: " " } } }).length).toBeGreaterThan(0)
  })
})

describe("decimal draft contracts and preview", () => {
  const invoice = { contactId: "c", supplyDate: "2026-12-01", dueDate: "2026-12-01", taxRate: "25", items: [{ description: "Precise", quantity: "0.123456", unitPrice: "123.4567" }] }
  it("requires strings in editor and agent schemas while compatibility accepts numbers", () => {
    expect(invoiceCreateDraftV2InputSchema.safeParse(invoice).success).toBe(true)
    expect(invoiceCreateDraftV2InputSchema.safeParse({ ...invoice, items: [{ description: "Numeric", quantity: 0.5, unitPrice: 100 }] }).success).toBe(false)
    expect(invoiceCreateDraftInputSchema.safeParse({ ...invoice, taxRate: 25, items: [{ description: "Numeric", quantity: 0.5, unitPrice: 100 }] }).success).toBe(true)
    expect(quoteCreateDraftV2InputSchema.safeParse({ ...invoice, expiryDate: invoice.dueDate }).success).toBe(true)
    expect(recurringCreateV2InputSchema.safeParse({ ...invoice, name: "Schedule", startDate: invoice.dueDate }).success).toBe(true)
    const agreement = { contactId: "c", title: "Work", validUntil: "2026-12-01", taxRate: "25", deliverables: [{ title: "Work", quantity: "0.123456", unitPrice: "123.4567" }] }
    expect(agreementCreateDraftDecimalInputSchema.safeParse(agreement).success).toBe(true)
    expect(agreementCreateDraftDecimalInputSchema.safeParse({ ...agreement, deliverables: [{ title: "Work", quantity: 0.5, unitPrice: 100 }] }).success).toBe(false)
    for (const patch of [{ quantity: "0.1234567" }, { unitPrice: "123.45678" }])
      expect(invoiceCreateDraftV2InputSchema.safeParse({ ...invoice, items: [{ ...invoice.items[0], ...patch }] }).success).toBe(false)
  })
  it("uses explicit VAT per line and supports multiple groups with incomplete draft evidence", () => {
    const result = calculateDraft({ currency: "USD", pricesIncludeTax: false, taxRate: "25", items: [
      { description: "Standard", quantity: "1", unitPrice: "100" },
      { description: "Exempt", quantity: "1", unitPrice: "100", vat: { treatment: "exempt", reasonCode: "health" } },
    ] })
    expect([result.net, result.tax, result.gross]).toEqual(["200.00", "25.00", "225.00"])
    expect(result.groups).toHaveLength(2)
  })
  it("does not return a guessed preview for an incomplete decimal", () => {
    const preview = previewDraft({ ...invoice, currency: "USD", pricesIncludeTax: false, items: [{ ...invoice.items[0]!, quantity: "" }] })
    expect(preview.result).toBeNull()
    expect(preview.error).not.toBeNull()
  })
})
