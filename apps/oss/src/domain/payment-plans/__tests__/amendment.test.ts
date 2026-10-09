import { describe, expect, it } from "vitest"
import { implicitCollectionPlan } from "../authority"
import { consentReasons, noFacts, planAmendmentImpact } from "../amendment"
import type { CollectionAuthority, PlanVersion, RecurringInstruction } from "../model"
import { recurringAmendmentImpact } from "../recurring-instructions"
import { validatePlan } from "../validate"
import { accepted, agreementObligation, dkk, invoiceObligation, onAccepted, plan, shareStep } from "./fixtures"

const seller = { source: "seller_amendment" as const, actor: { kind: "user" as const, id: "user_1" }, reason: "Rescheduled" }

describe("collection installments on one issued invoice", () => {
  // The #46 acceptance case: a 1,000 DKK invoice with 400 DKK paid moves its remaining 600 DKK later.
  const invoice = invoiceObligation({ invoiceId: "inv_1", issuedOn: "2026-10-01", dueDate: "2026-10-15", gross: "1000" })
  const implicit = implicitCollectionPlan(invoice, "plan_inv_1")!
  const moved = plan(invoice, { kind: "collection_installments", installments: [
    { installmentId: "paid", grossMinor: dkk("400"), dueDate: "2026-10-15" },
    { installmentId: "rest", grossMinor: dkk("600"), dueDate: "2026-12-01" },
  ] }, seller)
  const facts = { ...noFacts, paidMinor: dkk("400"), reminders: [{ reminderId: "rem_1", targetId: "due" }] }

  it("moves the unpaid 600.00 later without touching the paid 400.00 or the invoice", () => {
    expect(validatePlan(invoice, moved)).toEqual([])
    const impact = planAmendmentImpact(implicit, moved, invoice, facts)
    expect(impact).toMatchObject({
      refusals: [], lockedInstallments: [{ dueDate: "2026-10-15", grossMinor: dkk("400") }],
      consent: { required: false, reasons: [] }, notifyCustomer: true, remindersToReschedule: ["rem_1"], draftsToRegenerate: [], issuedUnchanged: [],
    })
    expect(impact.changedTargets.sort()).toEqual(["due", "paid", "rest"])
  })

  it("refuses rewriting the paid part and asks consent before collecting sooner", () => {
    const rewritten = plan(invoice, { kind: "collection_installments", installments: [
      { installmentId: "a", grossMinor: dkk("500"), dueDate: "2026-10-15" }, { installmentId: "b", grossMinor: dkk("500"), dueDate: "2026-12-01" },
    ] }, seller)
    expect(planAmendmentImpact(implicit, rewritten, invoice, facts).refusals).toMatchObject([{ code: "paid_installment_immutable" }])
    const sooner = { ...moved, version: 2, supersedes: 1, arrangement: { kind: "collection_installments" as const, installments: [
      { installmentId: "paid", grossMinor: dkk("400"), dueDate: "2026-10-15" }, { installmentId: "rest", grossMinor: dkk("600"), dueDate: "2026-11-01" },
    ] } }
    const later = { ...moved, version: 2, supersedes: 1 }
    expect(planAmendmentImpact(later, sooner, invoice, facts).consent).toEqual({ required: true, reasons: ["Asks for 600.00 DKK more by 2026-11-01"] })
  })

  it("tells when a saved-method authority would no longer cover the charges", () => {
    const authority: CollectionAuthority = {
      authorityId: "auth_1", version: 1, status: "active", scope: { kind: "plan", planId: "plan_inv_1", version: 1 }, currency: "DKK",
      maxChargeMinor: dkk("500"), minDaysBetweenCharges: 25, consentEvidenceRef: "mandate_1",
    }
    // Paid installments are never charged again, so only the 600.00 counts.
    expect(planAmendmentImpact(implicit, moved, invoice, facts, authority).authority).toEqual({ renewalRequired: true, reasons: ["A charge exceeds the authorized maximum"] })
    const covered = planAmendmentImpact(implicit, moved, invoice, facts, { ...authority, maxChargeMinor: dkk("600") }).authority
    expect(covered).toEqual({ renewalRequired: false, reasons: [] })
  })
})

describe("billing step amendments on an agreement", () => {
  const obligation = agreementObligation({ agreementId: "agr_2", acceptedOn: "2026-10-01", lines: [{ id: "website", net: "20000" }] })
  const v1 = plan(obligation, { kind: "billing_steps", steps: [shareStep("first", dkk("12500"), accepted), shareStep("second", dkk("12500"), onAccepted("website"))] })
  const facts = {
    ...noFacts,
    documents: [{ targetId: "first", invoiceId: "INV-1", status: "issued" as const }, { targetId: "second", invoiceId: "INV-2", status: "draft" as const }],
    reminders: [{ reminderId: "rem_first", targetId: "first" }, { reminderId: "rem_second", targetId: "second" }],
  }

  it("keeps the issued step, regenerates the affected draft and reschedules only its reminders", () => {
    const v2 = { ...v1, version: 2, supersedes: 1, ...seller, arrangement: { kind: "billing_steps" as const, steps: [
      shareStep("first", dkk("12500"), accepted), shareStep("second", dkk("6250"), onAccepted("website")), shareStep("third", dkk("6250"), onAccepted("website"), 44),
    ] } }
    expect(validatePlan(obligation, v2)).toEqual([])
    expect(planAmendmentImpact(v1, v2, obligation, facts)).toMatchObject({
      refusals: [], issuedUnchanged: ["INV-1"], draftsToRegenerate: [{ invoiceId: "INV-2", targetId: "second", reason: "changed" }],
      remindersToReschedule: ["rem_second"], changedTargets: ["second", "third"], consent: { required: false }, notifyCustomer: true,
    })
    // A fixed date may come before the website is accepted, so it can ask for money sooner.
    const dated = { ...v2, arrangement: { kind: "billing_steps" as const, steps: [...v2.arrangement.steps.slice(0, 2), shareStep("third", dkk("6250"), { kind: "on_date", date: "2027-02-01" })] } }
    expect(planAmendmentImpact(v1, dated, obligation, facts).consent).toEqual({ required: true, reasons: ["Asks for 6250.00 DKK more by 2027-02-15"] })
  })

  it("refuses changing an issued step; that needs a credit note and a new step", () => {
    const v2 = { ...v1, version: 2, supersedes: 1, ...seller, arrangement: { kind: "billing_steps" as const, steps: [
      shareStep("first", dkk("7500"), accepted), shareStep("second", dkk("17500"), onAccepted("website")),
    ] } }
    expect(planAmendmentImpact(v1, v2, obligation, facts).refusals).toMatchObject([{ code: "issued_step_immutable" }])
  })

  it("needs consent between a later fixed due date and a potentially earlier deliverable event, in both directions", () => {
    const dated = plan(obligation, { kind: "billing_steps", steps: [shareStep("first", dkk("12500"), accepted), shareStep("second", dkk("12500"), { kind: "on_date", date: "2027-03-01" })] })
    const onEvent = { ...dated, version: 2, supersedes: 1, arrangement: { kind: "billing_steps" as const, steps: [
      shareStep("first", dkk("12500"), accepted), shareStep("second", dkk("12500"), onAccepted("website")),
    ] } }
    expect(consentReasons(dated, onEvent, obligation)).toEqual(["Asks for 12500.00 DKK more by acceptance of website + 14 days"])
    expect(consentReasons(onEvent, dated, obligation)).toEqual(["Asks for 12500.00 DKK more by 2027-03-15"])
    // Deferring an event-based step is always favourable.
    const deferred = { ...onEvent, arrangement: { kind: "billing_steps" as const, steps: [shareStep("first", dkk("12500"), accepted), shareStep("second", dkk("12500"), onAccepted("website"), 30)] } }
    expect(consentReasons(onEvent, deferred, obligation)).toEqual([])
    expect(consentReasons(deferred, onEvent, obligation)).toEqual(["Asks for 12500.00 DKK more by acceptance of website + 14 days"])
  })

  it("refuses shrinking an advance below what was already received", () => {
    const advance = (gross: string): PlanVersion => plan(obligation, { kind: "advance_then_billing", application: "next_sale_invoice",
      advances: [{ advanceId: "adv", label: "Advance", grossMinor: dkk(gross), trigger: accepted, dueInDays: 7 }],
      steps: [shareStep("all", dkk("25000"), onAccepted("website"))] })
    const received = { ...noFacts, advanceReceipts: [{ advanceId: "adv", grossMinor: dkk("7500") }] }
    expect(planAmendmentImpact(advance("7500"), { ...advance("5000"), version: 2, supersedes: 1 }, obligation, received).refusals).toMatchObject([{ code: "received_advance_immutable" }])
    // Asking for a larger advance asks for money sooner.
    expect(planAmendmentImpact(advance("7500"), { ...advance("10000"), version: 2, supersedes: 1 }, obligation, received).consent.required).toBe(true)
  })
})

describe("recurring instruction amendments", () => {
  const v1: RecurringInstruction = {
    recurringInvoiceId: "rec_support", version: 1, currency: "DKK", periodGrossMinor: dkk("1875"), intervalUnit: "month", intervalCount: 1,
    anchorDate: "2026-11-01", effectiveFrom: "2026-11-01", dueInDays: 14, end: { type: "none" }, delivery: "draft_only", collection: { kind: "manual" },
  }
  const runs = [
    { runDate: "2026-11-01", invoiceId: "INV-11", status: "issued" as const },
    { runDate: "2026-12-01", invoiceId: "INV-12", status: "issued" as const },
    { runDate: "2027-01-01", invoiceId: "INV-13", status: "draft" as const },
  ]

  it("raises the price from January: earlier invoices stay, the January draft is rebuilt, the customer must agree", () => {
    const v2 = { ...v1, version: 2, effectiveFrom: "2027-01-01", periodGrossMinor: dkk("2250") }
    const impact = recurringAmendmentImpact(v1, v2, { today: "2026-12-20", generatedRuns: runs })
    expect(impact).toMatchObject({
      refusals: [], unchangedRuns: ["INV-11", "INV-12"], draftsToRegenerate: [{ invoiceId: "INV-13", runDate: "2027-01-01" }],
      consent: { required: true, reasons: ["Price rises from 1875.00 to 2250.00 DKK per period"] }, requiresHumanActivation: false, authority: null,
    })
    expect(impact.futureRuns.map((run) => [run.before?.periodGrossMinor, run.after?.periodGrossMinor, run.changed]))
      .toEqual([[dkk("1875"), dkk("2250"), true], [dkk("1875"), dkk("2250"), true], [dkk("1875"), dkk("2250"), true]])
  })

  it("refuses rewriting an issued run or the past", () => {
    const v2 = { ...v1, version: 2, effectiveFrom: "2026-12-01", periodGrossMinor: dkk("1500") }
    expect(recurringAmendmentImpact(v1, v2, { today: "2026-11-20", generatedRuns: runs }).refusals).toMatchObject([{ code: "issued_step_immutable" }])
    expect(recurringAmendmentImpact(v1, { ...v2, effectiveFrom: "2026-11-15" }, { today: "2026-11-20", generatedRuns: [] }).refusals).toMatchObject([{ code: "effective_date_in_past" }])
  })

  it("flags more frequent invoices, shorter terms and turning on unattended sending", () => {
    const v2 = { ...v1, version: 2, effectiveFrom: "2027-01-01", intervalUnit: "week" as const, intervalCount: 2, periodGrossMinor: dkk("865"), dueInDays: 7, delivery: "auto_send" as const }
    const impact = recurringAmendmentImpact(v1, v2, { today: "2026-12-20", generatedRuns: [] })
    expect(impact.consent.reasons).toEqual(["Invoices come more often", "Payment terms are shorter"])
    expect(impact.requiresHumanActivation).toBe(true)
    expect(impact.futureRuns.map((run) => run.after?.runDate)).toEqual(["2027-01-10", "2027-01-24", "2027-02-07"])
  })

  it("asks to renew a saved-method authority the new amount exceeds", () => {
    const withAuthority = { ...v1, collection: { kind: "saved_method" as const, authorityId: "auth_r" } }
    const authority: CollectionAuthority = {
      authorityId: "auth_r", version: 1, status: "active", scope: { kind: "recurring", recurringInvoiceId: "rec_support", version: 1 }, currency: "DKK",
      maxChargeMinor: dkk("2000"), minDaysBetweenCharges: 25, consentEvidenceRef: "mandate_r",
    }
    const raise = { ...withAuthority, version: 2, effectiveFrom: "2027-01-01", periodGrossMinor: dkk("2250") }
    expect(recurringAmendmentImpact(withAuthority, raise, { today: "2026-12-20", generatedRuns: [] }, authority).authority).toEqual({ renewalRequired: true, reasons: ["A charge exceeds the authorized maximum"] })
    expect(recurringAmendmentImpact(withAuthority, { ...raise, periodGrossMinor: dkk("1500") }, { today: "2026-12-20", generatedRuns: [] }, authority).authority).toEqual({ renewalRequired: false, reasons: [] })
  })
})
