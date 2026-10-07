import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createInvoiceDraft } from "../../domain/commands/invoices"
import { recordPayment } from "../../domain/commands/payments"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { issueDocument } from "../issuance"
import { invoiceIssuedSchema, creditNoteIssuedSchema } from "../../domain/events/money"
import { TestLedger } from "../../domain/accounting/__tests__/ledger"
import { postingsFor, type PostingEvent } from "../../domain/accounting/postings"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import type { VatEvidence } from "@quits/contracts/vat"

const cleanups: Array<() => Promise<void>> = []
beforeEach(() => { vi.stubEnv("RESEND_API_KEY", "") })
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.unstubAllEnvs() })
const intraEvidence: VatEvidence = { buyerVatId: "DE123456789", viesCheck: { at: "2026-10-07T12:00:00.000Z", result: "valid" }, statementText: "Reverse charge" }
const line = (price = "100", vat?: DocumentLineInput["vat"]): DocumentLineInput => ({ description: "Work", quantity: "1", unitPrice: price, ...(vat ? { vat } : {}) })
const zeroVat = (treatment: "intra_community" | "export" | "exempt" | "out_of_scope", reasonCode?: "goods" | "services_b2b" | "goods_outside_eu" | "health"): DocumentLineInput["vat"] => ({ treatment, rate: "0", country: "DK", reasonCode: reasonCode ?? null })
async function setup(input: { currency?: string; inclusive?: boolean; items?: DocumentLineInput[]; evidence?: VatEvidence; supplyDate?: string; nonVat?: boolean } = {}) {
  const org = await createTestOrganization({ settings: { currency: "DKK", countryCode: "DK", taxRegime: input.nonVat ? "none" : "dk_vat", pricesIncludeTax: input.inclusive ?? false } })
  cleanups.push(org.cleanup)
  await prisma.organizationTaxId.create({ data: { organizationId: org.organizationId, scheme: input.nonVat ? "CVR" : "VAT", value: input.nonVat ? "12345678" : "DK12345678" } })
  const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Buyer", country: "US", email: "buyer@example.test", taxIds: { create: { scheme: "VAT", value: "DE123456789" } } } })
  const result = await executeCommand(createInvoiceDraft, { contactId: contact.id, currency: input.currency ?? "DKK", dueDate: "2099-01-01", supplyDate: input.supplyDate ?? "2099-01-01", taxRate: "25", vatEvidence: input.evidence, items: input.items ?? [line()] }, { actor: org.actors.admin })
  if (result.status !== "completed") throw new Error(JSON.stringify(result))
  return { org, actor: org.actors.admin, invoice: result.result }
}
type Context = Awaited<ReturnType<typeof setup>>
async function issue(context: Context, extra: Record<string, unknown> = {}) {
  return issueDocument({ kind: "invoice", actor: context.actor, commandInput: { id: context.invoice.id, allowSendWithoutEmail: true, ...(context.invoice.currency !== "DKK" ? { exchangeRate: "7.45", rateDate: "2026-10-07" } : {}), ...extra } })
}
async function issued(context: Context, extra: Record<string, unknown> = {}) {
  const result = await issue(context, extra)
  expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" })
  const event = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: context.invoice.id, type: "invoice.issued" } })
  return { type: event.type, schemaVersion: event.schemaVersion, payload: invoiceIssuedSchema.parse(event.payload) }
}
async function credit(context: Context, amount?: string) {
  const result = await issueDocument({ kind: "creditNote", actor: context.actor, commandInput: { invoiceId: context.invoice.id, mode: amount ? "amount" : "full", ...(amount ? { amount } : {}), reason: "Correction" } })
  expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" })
  if (result.status !== "completed") throw new Error("Credit failed")
  const e = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: result.result.id, type: "credit_note.issued" } })
  const p = creditNoteIssuedSchema.parse(e.payload)
  if (!("historicalReversal" in p)) throw new Error("Sparse credit")
  return { type: e.type, schemaVersion: e.schemaVersion, payload: p }
}
/** Perturb only facts the issuer refuses or reserves; money starts as the real frozen event. */
function changed(event: PostingEvent, change: (p: Record<string, any>) => void): PostingEvent {
  const copy = structuredClone(event); change(copy.payload as Record<string, any>); return copy
}
function ending(ledger: TestLedger, key: string, debtor: string, revenue: string, output_vat = "0", payable_rounding = "0") {
  ledger.assertEnding({ debtor, revenue, output_vat, payable_rounding }, { [key]: { revenue, output_vat, payable_rounding } })
}

;(hasTestDatabase ? describe : describe.skip)("A4 Phase A acceptance through real issuance", () => {
  it("1: standard and intra-community goods, requiring buyer VAT and VIES", async () => {
    const c = await setup({ items: [line(), line("100", zeroVat("intra_community", "goods"))], evidence: intraEvidence })
    const e = await issued(c), ledger = new TestLedger(); ledger.apply(e)
    const standard = e.payload.vatGroups.find(g => g.treatment === "standard")!, goods = e.payload.vatGroups.find(g => g.treatment === "intra_community")!
    for (const field of ["buyerVatId", "viesCheck"]) ledger.refuse(changed(e, p => { delete p.vatGroups.find((g: any) => g.treatment === "intra_community").evidence[field] }), "unsupported_treatment_combination")
    ledger.assertEnding({ debtor: "22500", revenue: "-20000", output_vat: "-2500" }, { [standard.key]: { revenue: "-10000", output_vat: "-2500" }, [goods.key]: { revenue: "-10000" } })
    for (const field of ["buyerVatId", "viesCheck"] as const) {
      const evidence = { ...intraEvidence }; delete evidence[field]
      expect(await issue(await setup({ items: [line("100", zeroVat("intra_community", "goods"))], evidence }))).toMatchObject({ status: "failed" })
    }
  })
  it("2: services AE, export G and exempt E retain zero-tax groups", async () => {
    const ledger = new TestLedger(), groups: Record<string, { revenue: string }> = {}
    for (const [vat, evidence] of [[zeroVat("intra_community", "services_b2b"), intraEvidence], [zeroVat("export", "goods_outside_eu"), { exportEvidence: { kind: "other", ref: "customs-1" } }], [zeroVat("exempt", "health"), { statementText: "Health exemption" }]] as const) {
      const e = await issued(await setup({ items: [line("100", vat)], evidence }))
      expect(ledger.apply(e).some(l => l.role === "output_vat")).toBe(false)
      groups[e.payload.vatGroups[0]!.key] = { revenue: "-10000" }
    }
    ledger.assertEnding({ debtor: "30000", revenue: "-30000" }, groups)
  })
  it("3: inclusive two-cent sale and full cancellation reverse rounding", async () => {
    const c = await setup({ inclusive: true, items: [line("0.01"), line("0.01")] }), e = await issued(c), ledger = new TestLedger(), key = e.payload.vatGroups[0]!.key
    expect(e.payload.totals).toMatchObject({ net: "0.02", tax: "0.01", payableRounding: "-0.01" })
    expect(e.payload.lines.map(l => l.net)).toEqual(["0.01", "0.01"])
    expect(e.payload.lines.map(l => l.tax)).toEqual(["0.01", "0.00"])
    ledger.apply(e); ending(ledger, key, "2", "-2", "-1", "1")
    ledger.apply(await credit(c)); ending(ledger, key, "0", "0")
  })
  it("4: cumulative partial credits exhaust tax and reject a fifth", async () => {
    const c = await setup({ items: [line("0.06")] }), e = await issued(c), ledger = new TestLedger(), key = e.payload.vatGroups[0]!.key
    ledger.apply(e); ending(ledger, key, "8", "-6", "-2")
    const expected = [["0.02", "0.01", "6", "-5", "-1"], ["0.02", "0.00", "4", "-3", "-1"], ["0.03", "0.01", "1", "-1", "0"], ["0.01", "0.00", "0", "0", "0"]]
    let tax = 0n
    for (const [amount, reversalTax, debtor, revenue, output_vat] of expected) {
      const ce = await credit(c, amount); expect(ce.payload.totals.tax).toBe(reversalTax)
      tax += BigInt(ce.payload.totals.tax.replace(".", "")); expect(tax <= 2n).toBe(true)
      ledger.apply(ce); ending(ledger, key, debtor!, revenue!, output_vat!)
    }
    expect(await issueDocument({ kind: "creditNote", actor: c.actor, commandInput: { invoiceId: c.invoice.id, mode: "amount", amount: "0.01", reason: "Excess" } })).toMatchObject({ status: "failed" })
    ending(ledger, key, "0", "0")
  })
  it("4b: EUR base valuation and inclusive rounding both cancel exactly", async () => {
    for (const [inclusive, items, exchangeRate, debtor, revenue, output_vat, payable_rounding] of [
      [false, [line("0.03")], "7.45", "30", "-23", "-7", "0"],
      [true, [line("0.01"), line("0.01")], "7.4567", "15", "-15", "-7", "7"],
    ] as const) {
      const c = await setup({ currency: "EUR", inclusive, items: [...items] }), e = await issued(c, { exchangeRate }), ledger = new TestLedger(), key = e.payload.vatGroups[0]!.key
      ledger.apply(e); ending(ledger, key, debtor, revenue, output_vat, payable_rounding)
      ledger.apply(await credit(c)); ending(ledger, key, "0", "0")
    }
  })
  it("4c: valid services evidence never permits a 25% rate", async () => {
    const e = await issued(await setup({ items: [line("100", zeroVat("intra_community", "services_b2b"))], evidence: intraEvidence })), ledger = new TestLedger()
    ledger.refuse(changed(e, p => { p.vatGroups[0].rate = "0.25" }), "unsupported_treatment_combination"); ledger.assertEnding({}, {})
  })
  it("4d: negative third base net credits revenue and all five credits exhaust", async () => {
    const c = await setup({ currency: "EUR", items: [line("0.04")] }), e = await issued(c, { exchangeRate: "0.8" }), ledger = new TestLedger(), key = e.payload.vatGroups[0]!.key
    ledger.apply(e); ending(ledger, key, "4", "-3", "-1")
    const expected = [["3", "-2", "-1"], ["2", "-1", "-1"], ["2", "-2", "0"], ["1", "-1", "0"], ["0", "0", "0"]]
    for (const [i, [debtor, revenue, output_vat]] of expected.entries()) {
      const ce = await credit(c, "0.01"), lines = ledger.apply(ce)
      if (i === 2) {
        expect(ce.payload.historicalReversal[0]!.revenueBase).toBe("-0.01")
        expect(lines).toContainEqual(expect.objectContaining({ role: "revenue", creditMinor: "1", debitMinor: "0" }))
        expect(lines).toContainEqual(expect.objectContaining({ role: "output_vat", debitMinor: "1", creditMinor: "0" }))
      }
      ending(ledger, key, debtor!, revenue!, output_vat!)
    }
  })
  it("5: paid credit stays incomplete; prepayment and excess after prior credit refuse", async () => {
    const c = await setup(), e = await issued(c), ledger = new TestLedger(), key = e.payload.vatGroups[0]!.key
    ledger.apply(e)
    expect(await executeCommand(recordPayment, { invoiceId: c.invoice.id, amount: 10, method: "bank_transfer", paidAt: "2026-10-07" }, { actor: c.actor })).toMatchObject({ status: "completed" })
    const ce = await credit(c, "5"); expect(ce.payload.incompleteReason).toBe("allocations_pending"); ledger.refuse(ce, "not_postable")
    ledger.refuse(changed(ce, p => { p.postable = true; delete p.incompleteReason; p.correctsPurpose = "prepayment" }), "purpose_not_supported")
    ending(ledger, key, "12500", "-10000", "-2500")
    const other = await setup(), original = await issued(other), partial = new TestLedger(), k = original.payload.vatGroups[0]!.key
    partial.apply(original); partial.apply(await credit(other, "100"))
    expect(await issueDocument({ kind: "creditNote", actor: other.actor, commandInput: { invoiceId: other.invoice.id, mode: "amount", amount: "26", reason: "Exceeds 25 remaining" } })).toMatchObject({ status: "failed" })
    ending(partial, k, "2500", "-2000", "-500")
  })
  it("6: nonregistered seller posts only out-of-scope; unsupported combinations refuse", async () => {
    const e = await issued(await setup({ nonVat: true, items: [line("100", zeroVat("out_of_scope"))] })), ledger = new TestLedger(), key = e.payload.vatGroups[0]!.key
    ledger.apply(e)
    for (const treatment of ["reverse_charge_domestic", "zero_rated", "standard"]) ledger.refuse(changed(e, p => { p.vatGroups[0].treatment = treatment }), "unsupported_treatment_combination")
    ledger.refuse(changed(e, p => { p.vatGroups.push({ ...p.vatGroups[0], treatment: "exempt", reasonCode: "health" }) }), "unsupported_treatment_combination")
    const intra = await issued(await setup({ items: [line("100", zeroVat("intra_community", "goods"))], evidence: intraEvidence }))
    ledger.refuse(changed(intra, p => { p.vatGroups[0].evidence.viesCheck.result = "invalid" }), "unsupported_treatment_combination")
    ending(ledger, key, "10000", "-10000")
  })
  it("7: one day before issue refuses; equal is postable; legacy null refuses", async () => {
    const date = new Date().toISOString().slice(0, 10), before = new Date(`${date}T00:00:00Z`); before.setUTCDate(before.getUTCDate() - 1)
    const review = await issued(await setup({ supplyDate: before.toISOString().slice(0, 10) })), ledger = new TestLedger()
    expect(review.payload.taxPointReason).toBe("tax_point_review"); ledger.refuse(review, "tax_point_review_required"); ledger.assertEnding({}, {})
    const equal = await issued(await setup({ supplyDate: date })); expect(equal.payload.issueDate).toBe(date); ledger.apply(equal)
    ledger.refuse(changed(equal, p => { p.supplyDate = null; p.calculation.version = "legacy_per_line" }), "tax_point_review_required")
    ending(ledger, equal.payload.vatGroups[0]!.key, "12500", "-10000", "-2500")
  })
  it("8: legacy unknown valuation and unclassified zero never manufacture postings", async () => {
    const e = await issued(await setup()), ledger = new TestLedger()
    ledger.refuse(changed(e, p => { delete p.valuation }), "base_valuation_unknown")
    ledger.refuse(changed(e, p => { p.vatGroups[0].treatment = "unclassified_zero"; p.vatGroups[0].rate = "0" }), "unsupported_treatment_combination")
    ledger.assertEnding({}, {})
  })
  it("9: prepayment, advances, applications and real Phase B events refuse", async () => {
    const c = await setup(), e = await issued(c), ledger = new TestLedger()
    ledger.refuse(changed(e, p => { p.purpose = "prepayment" }), "purpose_not_supported")
    ledger.refuse(changed(e, p => { p.coveredByAdvances = [{}] }), "advances_not_supported")
    ledger.refuse(changed(e, p => { p.depositApplications = [{}] }), "applications_not_supported")
    expect(await executeCommand(recordPayment, { invoiceId: c.invoice.id, amount: 1, method: "bank_transfer", paidAt: "2026-10-07" }, { actor: c.actor })).toMatchObject({ status: "completed" })
    const payment = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: c.invoice.id, type: "payment.recorded" } }); ledger.refuse(payment, "event_not_supported"); ledger.assertEnding({}, {})
    const draft = await setup(); await prisma.invoice.update({ where: { id: draft.invoice.id }, data: { purpose: "prepayment" } })
    expect(await issue(draft)).toMatchObject({ status: "failed", error: { code: "purpose_issuance_not_supported" } })
    expect(await prisma.domainEvent.count({ where: { aggregateId: draft.invoice.id, type: "invoice.issued" } })).toBe(0)
  })
  it("10: frozen equations hold for applied events; reporting rate is ignored", async () => {
    const c = await setup({ currency: "EUR", items: [line("0.04")] }), e = await issued(c, { exchangeRate: "0.8", vatReporting: { rate: "0.9", rateSource: "user", taxBaseForReturn: "0.04", taxForReturn: "0.01" } }), ledger = new TestLedger(), key = e.payload.vatGroups[0]!.key
    expect(e.payload.vatReporting?.rate).toBe("0.9")
    expect(postingsFor(e)).toEqual(postingsFor(changed(e, p => { delete p.vatReporting })))
    ledger.apply(e); ending(ledger, key, "4", "-3", "-1")
    ledger.refuse(changed(e, p => { p.vatGroups[0].net = "0.05" }), "equation_violation")
    ledger.refuse(changed(e, p => { p.vatGroups[0].netBase = "0.05" }), "equation_violation")
    ending(ledger, key, "4", "-3", "-1")
  })
})
