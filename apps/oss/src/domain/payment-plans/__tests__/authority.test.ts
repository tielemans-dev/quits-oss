import { describe, expect, it } from "vitest"
import { adoptPlan, checkPlanRef, classifyStepDraft, emptyPlanState, recordConsent, withdrawPending, type AdoptContext, type PlanState } from "../authority"
import { noFacts } from "../amendment"
import type { PlanVersion } from "../model"
import { accepted, agreementObligation, dkk, invoiceObligation, onAccepted, plan, shareStep } from "./fixtures"

const obligation = agreementObligation({ agreementId: "agr_1", acceptedOn: "2026-10-01", lines: [{ id: "website", net: "20000" }] })
const offerConsent = { kind: "offer_acceptance" as const, offerRevision: 1, acceptedOn: "2026-10-01" }
const split = (first: string, second: string, overrides: Partial<PlanVersion> = {}) => plan(obligation, {
  kind: "billing_steps", steps: [shareStep("first", dkk(first), accepted), shareStep("second", dkk(second), onAccepted("website"))],
}, overrides)
const fifty = split("12500", "12500")
const context = (overrides: Partial<AdoptContext> = {}): AdoptContext =>
  ({ obligation, expectedVersion: null, expectedPaidMinor: "0", facts: noFacts, consent: offerConsent, ...overrides })
function adopted(state: PlanState, version: PlanVersion, overrides: Partial<AdoptContext> = {}) {
  const result = adoptPlan(state, version, context(overrides))
  if (!result.ok) throw new Error(JSON.stringify(result.refusal))
  return result
}
const accepted50 = adopted(emptyPlanState(fifty.planId, obligation), fifty).state
const amendment = (first: string, second: string, version = 2) =>
  split(first, second, { version, supersedes: 1, source: "seller_amendment", actor: { kind: "user", id: "user_1" }, reason: "Client asked" })

describe("one authoritative plan per obligation", () => {
  it("the accepted 50/50 plan is authoritative; a 30/70 plan attached by automation cannot become a second one", () => {
    expect(accepted50.current?.plan.arrangement).toEqual(fifty.arrangement)
    const automation = split("7500", "17500", { planId: "plan_automation", actor: { kind: "automation", id: "workflow_7" }, source: "seller_amendment" })
    expect(adoptPlan(accepted50, automation, context())).toMatchObject({ ok: false, refusal: { code: "automation_cannot_amend" } })
    const secondPlan = split("7500", "17500", { planId: "plan_other", actor: { kind: "user", id: "user_1" }, source: "seller_amendment" })
    expect(adoptPlan(accepted50, secondPlan, context({ expectedVersion: 1 }))).toMatchObject({ ok: false, refusal: { code: "plan_already_authoritative" } })
    const versionOneAgain = split("7500", "17500", { actor: { kind: "user", id: "user_1" } })
    expect(adoptPlan(accepted50, versionOneAgain, context())).toMatchObject({ ok: false, refusal: { code: "stale_plan_version" } })
  })

  it("lets only one of two amendments built on the same version win", () => {
    const thirty = adopted(accepted50, amendment("7500", "17500"), { expectedVersion: 1, consent: null })
    expect(thirty.outcome).toBe("authoritative")
    expect(thirty.state.current?.plan.version).toBe(2)
    // The second editor also started from version 1.
    expect(adoptPlan(thirty.state, amendment("10000", "15000"), context({ expectedVersion: 1, consent: null }))).toMatchObject({ ok: false, refusal: { code: "stale_plan_version" } })
    expect(adoptPlan(thirty.state, amendment("10000", "15000", 3), context({ expectedVersion: 1, consent: null }))).toMatchObject({ ok: false, refusal: { code: "stale_plan_version" } })
    // Rebuilt on version 2 it may proceed.
    const rebuilt = split("10000", "15000", { version: 3, supersedes: 2, source: "seller_amendment", actor: { kind: "user", id: "user_2" }, reason: null })
    expect(adoptPlan(thirty.state, rebuilt, context({ expectedVersion: 2, consent: null }))).toMatchObject({ ok: true, outcome: "awaiting_consent" })
  })

  it("adopts a customer-favourable change with a notice, and holds an earlier ask for consent", () => {
    const less = adopted(accepted50, amendment("7500", "17500"), { expectedVersion: 1, consent: null })
    expect(less.state.current?.consent).toEqual({ kind: "not_required", notifyCustomer: true })
    expect(less.state.history).toMatchObject([{ plan: { version: 1 }, outcome: "superseded" }])

    const more = adopted(accepted50, amendment("17500", "7500"), { expectedVersion: 1, consent: null })
    expect(more.outcome).toBe("awaiting_consent")
    expect(more.impact?.consent.reasons).toEqual(["Asks for 5000.00 DKK more by 2026-10-15"])
    expect(more.state.current?.plan.version).toBe(1)
    // While it waits, nothing else may amend the plan.
    expect(adoptPlan(more.state, amendment("12500", "12500", 3), context({ expectedVersion: 1, consent: null }))).toMatchObject({ ok: false, refusal: { code: "amendment_pending" } })
    const consent = { kind: "customer_consent" as const, evidenceRef: "email_42", recordedOn: "2026-10-05" }
    expect(recordConsent(more.state, { version: 3, expectedCurrentVersion: 1, consent, obligation, facts: noFacts })).toMatchObject({ ok: false, refusal: { code: "no_pending_amendment" } })
    const agreed = recordConsent(more.state, { version: 2, expectedCurrentVersion: 1, consent, obligation, facts: noFacts })
    expect(agreed).toMatchObject({ ok: true, state: { current: { plan: { version: 2 }, consent }, pending: null } })

    // A withdrawn version number is never reused.
    const withdrawn = withdrawPending(more.state)
    expect(withdrawn.nextVersion).toBe(3)
    expect(adoptPlan(withdrawn, amendment("12500", "12500", 2), context({ expectedVersion: 1, consent: null }))).toMatchObject({ ok: false, refusal: { code: "version_sequence" } })
    expect(adopted(withdrawn, amendment("7500", "17500", 3), { expectedVersion: 1, consent: null }).state.current?.plan.version).toBe(3)
  })

  it("rechecks issued steps when consent arrives after the step was issued", () => {
    const more = adopted(accepted50, amendment("17500", "7500"), { expectedVersion: 1, consent: null })
    const facts = { ...noFacts, documents: [{ targetId: "first", invoiceId: "INV-1", status: "issued" as const }] }
    const consent = { kind: "customer_consent" as const, evidenceRef: "email_42", recordedOn: "2026-10-20" }
    expect(recordConsent(more.state, { version: 2, expectedCurrentVersion: 1, consent, obligation, facts })).toMatchObject({ ok: false, refusal: { code: "issued_step_immutable" } })
  })

  it("starts an agreement plan only from the accepted offer revision", () => {
    const empty = emptyPlanState(fifty.planId, obligation)
    expect(adoptPlan(empty, fifty, context({ consent: null }))).toMatchObject({ ok: false, refusal: { code: "consent_does_not_match" } })
    expect(adoptPlan(empty, fifty, context({ consent: { ...offerConsent, offerRevision: 0 } }))).toMatchObject({ ok: false, refusal: { code: "consent_does_not_match" } })
    expect(adoptPlan(empty, { ...fifty, source: "seller_amendment", actor: { kind: "user", id: "u" } }, context())).toMatchObject({ ok: false, refusal: { code: "version_sequence" } })
    const stale = { ...fifty, obligation: { ...obligation.ref, offerRevision: 0 } }
    expect(adoptPlan(empty, stale as PlanVersion, context())).toMatchObject({ ok: false, refusal: { code: "stale_obligation_version" } })
  })

  it("refuses a collection plan prepared before a payment landed", () => {
    const invoice = invoiceObligation({ invoiceId: "inv_1", issuedOn: "2026-10-01", dueDate: "2026-10-15", gross: "1000" })
    const schedule = plan(invoice, { kind: "collection_installments", installments: [
      { installmentId: "a", grossMinor: dkk("400"), dueDate: "2026-10-15" }, { installmentId: "b", grossMinor: dkk("600"), dueDate: "2026-12-01" },
    ] }, { source: "seller_amendment", actor: { kind: "user", id: "u" } })
    const state = emptyPlanState(schedule.planId, invoice)
    const facts = { ...noFacts, paidMinor: dkk("400") }
    expect(adoptPlan(state, schedule, { obligation: invoice, expectedVersion: null, expectedPaidMinor: "0", facts, consent: null })).toMatchObject({ ok: false, refusal: { code: "stale_settlement" } })
    expect(adoptPlan(state, schedule, { obligation: invoice, expectedVersion: null, expectedPaidMinor: dkk("400"), facts, consent: null }))
      .toMatchObject({ ok: true, outcome: "authoritative", impact: { lockedInstallments: [{ dueDate: "2026-10-15", grossMinor: dkk("400") }], consent: { required: false } } })
  })
})

describe("references and exceptions", () => {
  it("accepts only references to the current version and its steps", () => {
    const next = adopted(accepted50, amendment("7500", "17500"), { expectedVersion: 1, consent: null }).state
    expect(checkPlanRef(next, { planId: fifty.planId, version: 2, stepId: "first" })).toBeNull()
    expect(checkPlanRef(next, { planId: fifty.planId, version: 1, stepId: "first" })).toMatchObject({ code: "stale_plan_reference" })
    expect(checkPlanRef(next, { planId: fifty.planId, version: 2, stepId: "deposit" })).toMatchObject({ code: "stale_plan_reference" })
    expect(checkPlanRef(next, { planId: "plan_other", version: 2 })).toMatchObject({ code: "stale_plan_reference" })
  })

  it("allows a later due date with a reason and separate lines, never a different amount or an earlier date", () => {
    const step = { stepGrossMinor: dkk("12500"), triggeredOn: "2026-10-01", dueInDays: 14, consent: null }
    expect(classifyStepDraft({ ...step, draft: { linkedGrossMinor: dkk("12500"), dueDate: "2026-11-01", unlinkedLines: 1 }, reason: "Client's budget closes in November" }))
      .toEqual({ ok: true, exceptions: [
        { kind: "later_due_date", detail: "Due 2026-11-01 instead of 2026-10-15: Client's budget closes in November" },
        { kind: "separate_obligation_lines", detail: "1 unlinked line(s) bill something outside the plan's obligation" },
      ] })
    expect(classifyStepDraft({ ...step, draft: { linkedGrossMinor: dkk("12500"), dueDate: "2026-11-01", unlinkedLines: 0 }, reason: null })).toMatchObject({ ok: false, refusal: { code: "exception_reason_required" } })
    expect(classifyStepDraft({ ...step, draft: { linkedGrossMinor: dkk("10000"), dueDate: "2026-10-15", unlinkedLines: 0 }, reason: "Smaller first payment" })).toMatchObject({ ok: false, refusal: { code: "amount_requires_plan_amendment" } })
    expect(classifyStepDraft({ ...step, draft: { linkedGrossMinor: dkk("12500"), dueDate: "2026-10-08", unlinkedLines: 0 }, reason: null })).toMatchObject({ ok: false, refusal: { code: "earlier_due_requires_consent" } })
    expect(classifyStepDraft({ ...step, consent: { kind: "customer_consent", evidenceRef: "call_note_3", recordedOn: "2026-10-02" }, draft: { linkedGrossMinor: dkk("12500"), dueDate: "2026-10-08", unlinkedLines: 0 }, reason: null })).toEqual({ ok: true, exceptions: [] })
  })
})
