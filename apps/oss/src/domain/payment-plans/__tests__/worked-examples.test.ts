import { describe, expect, it } from "vitest"
import { adoptPlan, emptyPlanState } from "../authority"
import { noFacts } from "../amendment"
import { resolveRatioShares, shareComponents, sumMinor } from "../amounts"
import { relate } from "../coexistence"
import type { RecurringInstruction } from "../model"
import { obligationPosition, type PositionInput } from "../position"
import { previewRuns, recurringAmendmentImpact } from "../recurring-instructions"
import { validatePlan } from "../validate"
import { accepted, agreementObligation, dkk, onAccepted, plan, shareStep } from "./fixtures"

/*
 * The decision record's worked examples (docs/plans/2026-10-08-canonical-payment-schedule-design.md),
 * executable. All amounts are DKK with 25% Danish VAT on top of the net price.
 */

const position = (input: PositionInput) => {
  const result = obligationPosition(input)
  if (!result.ok) throw new Error(JSON.stringify(result.refusals))
  return result.position
}

describe("example A: a fixed-price website split 50/50 into two sale invoices", () => {
  const obligation = agreementObligation({ agreementId: "agr_website", acceptedOn: "2026-10-01", lines: [{ id: "website", net: "20000" }] })
  const shares = resolveRatioShares(BigInt(obligation.grossMinor), [5000, 5000])
  const v1 = plan(obligation, { kind: "billing_steps", steps: [
    shareStep("first_half", shares[0]!.toString(), accepted),
    shareStep("second_half", shares[1]!.toString(), onAccepted("website")),
  ] })
  const base = { obligation, plan: v1, applications: [], refunds: [] }

  it("has one obligation of 25,000.00, two steps of 12,500.00 and VAT counted once", () => {
    expect(obligation.grossMinor).toBe(dkk("25000"))
    expect(validatePlan(obligation, v1)).toEqual([])
    const [first, second] = shareComponents(obligation.vatGroups, shares, "DKK")
    expect([first!.netMinor, first!.taxMinor, second!.netMinor, second!.taxMinor].map(String)).toEqual([dkk("10000"), dkk("2500"), dkk("10000"), dkk("2500")])
    const adopted = adoptPlan(emptyPlanState(v1.planId, obligation), v1, { obligation, expectedVersion: null, expectedPaidMinor: "0", facts: noFacts, consent: { kind: "offer_acceptance", offerRevision: 1, acceptedOn: "2026-10-01" } })
    expect(adopted).toMatchObject({ ok: true, outcome: "authoritative" })
  })

  it("tracks invoices, payments and the remaining balance without double counting", () => {
    const inv1 = { invoiceId: "INV-0001", stepId: "first_half", grossMinor: dkk("12500"), taxMinor: dkk("2500"), creditedMinor: "0" }
    const inv2 = { invoiceId: "INV-0002", stepId: "second_half", grossMinor: dkk("12500"), taxMinor: dkk("2500"), creditedMinor: "0" }
    const issued = position({ ...base, saleInvoices: [inv1], receipts: [] })
    expect(issued).toMatchObject({ invoicedMinor: 1_250_000n, uninvoicedMinor: 1_250_000n, receivableMinor: 1_250_000n, remainingMinor: 2_500_000n })
    const paidByCard = position({ ...base, saleInvoices: [inv1], receipts: [{ receiptId: "r1", method: "card", grossMinor: dkk("12500"), for: { kind: "invoice", invoiceId: "INV-0001" } }] })
    expect(paidByCard).toMatchObject({ receivableMinor: 0n, remainingMinor: 1_250_000n, uninvoicedMinor: 1_250_000n })
    const done = position({ ...base, saleInvoices: [inv1, inv2], receipts: [
      { receiptId: "r1", method: "card", grossMinor: dkk("12500"), for: { kind: "invoice", invoiceId: "INV-0001" } },
      { receiptId: "r2", method: "bank_transfer", grossMinor: dkk("12500"), for: { kind: "invoice", invoiceId: "INV-0002" } },
    ] })
    expect(done).toMatchObject({ invoicedMinor: 2_500_000n, uninvoicedMinor: 0n, receivableMinor: 0n, remainingMinor: 0n, saleTaxMinor: 500_000n })
  })

  it("refuses a second invoice for a step and an invoice outside the plan", () => {
    const inv1 = { invoiceId: "INV-0001", stepId: "first_half", grossMinor: dkk("12500"), taxMinor: dkk("2500"), creditedMinor: "0" }
    expect(obligationPosition({ ...base, receipts: [], saleInvoices: [inv1, { ...inv1, invoiceId: "INV-0009" }] })).toMatchObject({ ok: false, refusals: [{ code: "duplicate_step" }] })
    expect(obligationPosition({ ...base, receipts: [], saleInvoices: [{ invoiceId: "INV-0010", stepId: "full_price", grossMinor: dkk("25000"), taxMinor: dkk("5000"), creditedMinor: "0" }] }))
      .toMatchObject({ ok: false, refusals: [{ code: "stale_plan_reference" }] })
    // A fully credited step invoice may be replaced by one new invoice for the same step.
    expect(obligationPosition({ ...base, receipts: [], saleInvoices: [{ ...inv1, creditedMinor: inv1.grossMinor }, { ...inv1, invoiceId: "INV-0011" }] })).toMatchObject({ ok: true })
  })
})

describe("example B: a fixed-price service with a 30% advance", () => {
  const obligation = agreementObligation({ agreementId: "agr_identity", acceptedOn: "2026-10-01", lines: [{ id: "identity", net: "40000" }] })
  const v1 = plan(obligation, {
    kind: "advance_then_billing", application: "next_sale_invoice",
    advances: [{ advanceId: "advance", label: "30% advance", grossMinor: dkk("15000"), trigger: accepted, dueInDays: 7 }],
    steps: [{ stepId: "identity", label: "Brand identity", grossMinor: dkk("50000"), source: { kind: "deliverable", deliverableId: "identity" }, trigger: onAccepted("identity"), dueInDays: 14 }],
  })
  const finalInvoice = { invoiceId: "INV-0003", stepId: "identity", grossMinor: dkk("50000"), taxMinor: dkk("10000"), creditedMinor: "0" }
  const run = (advanceMethod: "card" | "bank_transfer", finalMethod: "card" | "bank_transfer") => position({
    obligation, plan: v1, saleInvoices: [finalInvoice], refunds: [],
    receipts: [
      { receiptId: "r_adv", method: advanceMethod, grossMinor: dkk("15000"), for: { kind: "advance", advanceId: "advance" } },
      { receiptId: "r_final", method: finalMethod, grossMinor: dkk("35000"), for: { kind: "invoice", invoiceId: "INV-0003" } },
    ],
    applications: [{ receiptId: "r_adv", invoiceId: "INV-0003", grossMinor: dkk("15000") }],
  })

  it("holds the advance apart from revenue until it is applied to the final sale", () => {
    expect(validatePlan(obligation, v1)).toEqual([])
    const held = position({ obligation, plan: v1, saleInvoices: [], applications: [], refunds: [],
      receipts: [{ receiptId: "r_adv", method: "bank_transfer", grossMinor: dkk("15000"), for: { kind: "advance", advanceId: "advance" } }] })
    expect(held).toMatchObject({ invoicedMinor: 0n, saleTaxMinor: 0n, advanceReceivedMinor: 1_500_000n, advanceAvailableMinor: 1_500_000n, receivableMinor: 0n, remainingMinor: 3_500_000n })
    const settled = run("bank_transfer", "card")
    expect(settled).toMatchObject({ invoicedMinor: 5_000_000n, saleTaxMinor: 1_000_000n, advanceAppliedMinor: 1_500_000n, advanceAvailableMinor: 0n, receivableMinor: 0n, remainingMinor: 0n })
    expect(settled.invoices[0]).toMatchObject({ grossMinor: 5_000_000n, appliedMinor: 1_500_000n, paidMinor: 3_500_000n, openMinor: 0n })
  })

  it("gives the same balances whether the advance is paid by card or bank transfer", () => {
    const { invoices: a, ...byCard } = run("card", "bank_transfer"), { invoices: b, ...byBank } = run("bank_transfer", "card")
    expect(byCard).toEqual(byBank)
    expect(a).toEqual(b)
  })

  it("shows unused advance after a partial application and refuses applying it twice", () => {
    const partial = position({ obligation, plan: v1, saleInvoices: [finalInvoice], refunds: [],
      receipts: [{ receiptId: "r_adv", method: "card", grossMinor: dkk("15000"), for: { kind: "advance", advanceId: "advance" } }],
      applications: [{ receiptId: "r_adv", invoiceId: "INV-0003", grossMinor: dkk("10000") }] })
    expect(partial).toMatchObject({ advanceAvailableMinor: 500_000n, receivableMinor: 4_000_000n, remainingMinor: 3_500_000n })
    expect(obligationPosition({ obligation, plan: v1, saleInvoices: [finalInvoice], refunds: [],
      receipts: [{ receiptId: "r_adv", method: "card", grossMinor: dkk("15000"), for: { kind: "advance", advanceId: "advance" } }],
      applications: [{ receiptId: "r_adv", invoiceId: "INV-0003", grossMinor: dkk("15000") }, { receiptId: "r_adv", invoiceId: "INV-0003", grossMinor: dkk("1") }] }))
      .toMatchObject({ ok: false, refusals: [{ code: "over_application" }] })
  })

  it("splits the obligation's VAT exactly across the advance and the rest, as an input to #24 rather than a decision", () => {
    const [advance, rest] = shareComponents(obligation.vatGroups, [1_500_000n, 3_500_000n], "DKK")
    expect([advance!.taxMinor, rest!.taxMinor]).toEqual([300_000n, 700_000n])
    expect(advance!.taxMinor + rest!.taxMinor).toBe(1_000_000n)
  })
})

describe("example C: a separate recurring support service", () => {
  const support: RecurringInstruction = {
    recurringInvoiceId: "rec_support", version: 1, currency: "DKK", periodGrossMinor: dkk("1875"), intervalUnit: "month", intervalCount: 1,
    anchorDate: "2026-11-01", effectiveFrom: "2026-11-01", dueInDays: 14, end: { type: "none" }, delivery: "draft_only", collection: { kind: "manual" },
  }

  it("generates one 1,875.00 invoice per month as its own period obligation", () => {
    expect(previewRuns(support, "2026-11-01", 3)).toEqual([
      { runDate: "2026-11-01", version: 1, periodGrossMinor: dkk("1875"), dueDate: "2026-11-15" },
      { runDate: "2026-12-01", version: 1, periodGrossMinor: dkk("1875"), dueDate: "2026-12-15" },
      { runDate: "2027-01-01", version: 1, periodGrossMinor: dkk("1875"), dueDate: "2027-01-15" },
    ])
    // Two periods invoiced, November paid by bank transfer: 1,875.00 remains, on December's invoice.
    const periods = [{ gross: dkk("1875"), paid: dkk("1875") }, { gross: dkk("1875"), paid: "0" }]
    expect(sumMinor(periods.map((period) => BigInt(period.gross) - BigInt(period.paid)))).toBe(187_500n)
  })

  it("coexists with the website plan and never bills that fixed obligation", () => {
    const website = { kind: "billing_plan" as const, id: "plan_agr_website", obligationKey: "agreement:agr_website" }
    expect(relate(website, { kind: "recurring", id: "rec_support", instructionKey: "recurring:rec_support", billsObligationKey: null })).toEqual({ relation: "independent", refusal: null })
    expect(relate(website, { kind: "recurring", id: "rec_split", instructionKey: "recurring:rec_split", billsObligationKey: "agreement:agr_website" }))
      .toMatchObject({ relation: "duplicate", refusal: { code: "recurring_cannot_split_fixed_obligation" } })
  })

  it("keeps invoice generation apart from automatic collection", () => {
    const next = { ...support, version: 2, effectiveFrom: "2027-01-01", collection: { kind: "saved_method" as const, authorityId: "auth_1" } }
    const impact = recurringAmendmentImpact(support, next, { today: "2026-12-10", generatedRuns: [] })
    expect(impact.refusals).toMatchObject([{ code: "arrangement_not_allowed" }])
  })
})
