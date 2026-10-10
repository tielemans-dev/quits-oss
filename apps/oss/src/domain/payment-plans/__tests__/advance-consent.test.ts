import { describe, expect, it } from "vitest"
import { consentReasons, dueEntries, noFacts, planAmendmentImpact, type PlanFacts } from "../amendment"
import { adoptPlan, emptyPlanState, withdrawPending } from "../authority"
import { planVersionSchema, type BillingStep, type CollectionAuthority, type PlanVersion } from "../model"
import { obligationPosition, type PositionInput } from "../position"
import { validatePlan } from "../validate"
import { accepted, agreementObligation, dkk, onAccepted, plan, shareStep } from "./fixtures"

const obligation = agreementObligation({ agreementId: "advance-consent", acceptedOn: "2026-10-01", lines: [{ id: "X", net: "400" }, { id: "Y", net: "400" }] })
const dated = (date: string) => ({ kind: "on_date" as const, date })
function schedule(steps: BillingStep[], advanceDays = 7): PlanVersion {
  return planVersionSchema.parse(plan(obligation, {
    kind: "advance_then_billing", application: "next_sale_invoice",
    advances: [{ advanceId: "advance", label: "Advance", grossMinor: dkk("500"), trigger: accepted, dueInDays: advanceDays }], steps,
  }))
}
const before = schedule([shareStep("final", dkk("1000"), dated("2026-10-20"), 0)])
const early = shareStep("early", dkk("500"), dated("2026-10-02"), 0)
const final = shareStep("final", dkk("500"), dated("2026-10-20"), 0)
const after = schedule([early, final])
const offerConsent = { kind: "offer_acceptance" as const, offerRevision: 1, acceptedOn: "2026-10-01" }
function amend(current: PlanVersion, proposed: PlanVersion, facts: PlanFacts = noFacts) {
  expect(validatePlan(obligation, current)).toEqual([])
  expect(validatePlan(obligation, proposed)).toEqual([])
  const context = { obligation, facts, expectedPaidMinor: facts.paidMinor }
  const initial = adoptPlan(emptyPlanState(current.planId, obligation), current, { ...context, expectedVersion: null, consent: offerConsent })
  if (!initial.ok) throw new Error(initial.refusal.detail)
  const next = { ...proposed, version: 2, supersedes: 1, source: "seller_amendment" as const, actor: { kind: "user" as const, id: "seller" }, reason: "Reschedule" }
  return { initial, next, result: adoptPlan(initial.state, next, { ...context, expectedVersion: 1, consent: null }) }
}
function waits(current: PlanVersion, proposed: PlanVersion, facts: PlanFacts = noFacts) {
  expect(consentReasons(current, proposed, obligation).length).toBeGreaterThan(0)
  const { initial, next, result } = amend(current, proposed, facts)
  expect(result).toMatchObject({ ok: true, outcome: "awaiting_consent", state: { current: initial.state.current, pending: next } })
  return result
}
function position(version: PlanVersion, grossReceived: string, applied: string, allSales = false) {
  if (version.arrangement.kind !== "advance_then_billing") throw new Error("Advance fixture required")
  const steps = allSales ? version.arrangement.steps : version.arrangement.steps.slice(0, 1)
  const input: PositionInput = {
    obligation, plan: version,
    saleInvoices: steps.map((step) => ({ invoiceId: `inv-${step.stepId}`, stepId: step.stepId, grossMinor: step.grossMinor, taxMinor: (BigInt(step.grossMinor) / 5n).toString(), creditedMinor: "0" })),
    receipts: grossReceived === "0" ? [] : [{ receiptId: "receipt", method: "bank_transfer", grossMinor: grossReceived, for: { kind: "advance", advanceId: "advance" } }],
    applications: applied === "0" ? [] : [{ receiptId: "receipt", invoiceId: `inv-${steps[0]!.stepId}`, grossMinor: applied }], refunds: [],
  }
  return obligationPosition(input)
}

describe("advance requests are not paid credit (A1)", () => {
  it("holds the early sale with no receipts and retains its actual receivable", () => {
    expect(position(after, "0", "0")).toMatchObject({ ok: true, position: { receivableMinor: 50000n, advanceReceivedMinor: 0n, advanceAppliedMinor: 0n, remainingMinor: 100000n } })
    waits(before, after)
  })

  it("holds the early unpaid remainder after a partial advance receipt and application", () => {
    expect(position(after, dkk("200"), dkk("200"))).toMatchObject({ ok: true, position: { receivableMinor: 30000n, advanceReceivedMinor: 20000n, advanceAppliedMinor: 20000n, advanceAvailableMinor: 0n, remainingMinor: 80000n } })
    waits(before, after, { ...noFacts, advanceReceipts: [{ advanceId: "advance", grossMinor: dkk("200") }] })
  })

  it("does not infer an application even from a fully received advance", () => {
    expect(position(after, dkk("500"), "0")).toMatchObject({ ok: true, position: { receivableMinor: 50000n, advanceAvailableMinor: 50000n, remainingMinor: 50000n } })
    waits(before, after, { ...noFacts, advanceReceipts: [{ advanceId: "advance", grossMinor: dkk("500") }] })
  })

  it("holds a multi-step sale whose first two requests were hidden by the requested pool", () => {
    waits(before, schedule([
      shareStep("one", dkk("200"), dated("2026-10-02"), 0),
      shareStep("two", dkk("300"), dated("2026-10-03"), 0), final,
    ]))
  })

  it.each([false, true])("holds independent event sales, reversed=%s", (reverse) => {
    const steps = [shareStep("x", dkk("500"), onAccepted("X"), 0), shareStep("y", dkk("500"), onAccepted("Y"), 0)]
    const ordered = reverse ? steps.reverse() : steps
    waits(schedule([shareStep("old", dkk("1000"), ordered[1]!.trigger, 0)]), schedule(ordered))
  })

  it("holds an application-order change even when gross requests and dates are identical", () => {
    // A received 500 could cover early in the old order but final in the new order.
    // Raw gross dominance cannot establish the actual 0 -> 500 early ask.
    const reversed = schedule([final, early])
    expect(position(after, dkk("500"), dkk("500"), true)).toMatchObject({ ok: true, position: { invoices: [{ stepId: "early", openMinor: 0n }, { stepId: "final", openMinor: 50000n }] } })
    expect(position(reversed, dkk("500"), dkk("500"), true)).toMatchObject({ ok: true, position: { invoices: [{ stepId: "final", openMinor: 0n }, { stepId: "early", openMinor: 50000n }] } })
    waits(after, reversed)
  })

  it("conservatively holds reordered equal-date sales without an application-history proof", () => {
    const steps = [shareStep("a", dkk("250"), dated("2026-10-20"), 0), shareStep("b", dkk("750"), dated("2026-10-20"), 0)]
    waits(schedule(steps), schedule([...steps].reverse()))
  })

  it("holds moving a sale trigger later when that can redirect the received pool", () => {
    const current = schedule([early, shareStep("later", dkk("500"), dated("2026-10-03"), 0)])
    const moved = schedule([{ ...early, trigger: dated("2026-10-04") }, shareStep("later", dkk("500"), dated("2026-10-03"), 0)])
    waits(current, moved)
  })

  it("requires consent when entering or leaving advance application semantics", () => {
    const ordinary = plan(obligation, { kind: "billing_steps", steps: [shareStep("final", dkk("1000"), dated("2026-10-20"), 0)] })
    waits(before, ordinary)
    waits(ordinary, before)
  })

  it.each([dated("2026-10-20"), onAccepted("X")])("keeps unchanged issuance and deferred sale payment terms consent-free (%j)", (trigger) => {
    const current = schedule([shareStep("sale", dkk("1000"), trigger, 14)])
    const deferred = schedule([shareStep("sale", dkk("1000"), trigger, 30)])
    expect(consentReasons(current, current, obligation)).toEqual([])
    expect(consentReasons(current, deferred, obligation)).toEqual([])
    expect(amend(current, deferred).result).toMatchObject({ ok: true, outcome: "authoritative", state: { current: { consent: { kind: "not_required", notifyCustomer: true } } } })
    waits(deferred, current)
  })

  it.each(["0", "200", "500"])("keeps multi-step payment-term deferrals with %s DKK received", (received) => {
    const current = schedule([early, final])
    const deferred = schedule([{ ...early, dueInDays: 14 }, { ...final, dueInDays: 30 }])
    const facts = { ...noFacts, advanceReceipts: received === "0" ? [] : [{ advanceId: "advance", grossMinor: dkk(received) }] }
    expect(amend(current, deferred, facts).result).toMatchObject({ ok: true, outcome: "authoritative" })
    const oldPosition = position(current, dkk(received), dkk(received), true)
    const newPosition = position(deferred, dkk(received), dkk(received), true)
    expect(newPosition).toEqual(oldPosition)
  })

  it("retains the accepted version when the customer declines", () => {
    const result = waits(before, after)
    if (!result.ok) throw new Error(result.refusal.detail)
    const declined = withdrawPending(result.state)
    expect(declined.current).toEqual(result.state.current)
    expect(declined.current?.consent).toEqual(offerConsent)
    expect(declined.history).toMatchObject([{ outcome: "withdrawn", plan: { version: 2 } }])
    expect(declined.nextVersion).toBe(3)
  })

  it("still refuses issued sale edits and reduction/removal of received advances", () => {
    expect(amend(before, after, { ...noFacts, documents: [{ targetId: "final", invoiceId: "immutable", status: "issued" }] }).result)
      .toMatchObject({ ok: false, refusal: { code: "issued_step_immutable" } })
    if (before.arrangement.kind !== "advance_then_billing") throw new Error("Advance fixture required")
    for (const advances of [[], [{ ...before.arrangement.advances[0]!, grossMinor: dkk("100") }]]) {
      const next = { ...before, arrangement: { ...before.arrangement, advances } }
      const impact = planAmendmentImpact(before, next, obligation, { ...noFacts, advanceReceipts: [{ advanceId: "advance", grossMinor: dkk("200") }] })
      expect(impact.refusals).toMatchObject([{ code: "received_advance_immutable" }])
    }
    const { initial, next } = amend(before, after)
    expect(adoptPlan(initial.state, { ...next, actor: { kind: "automation", id: "job" } }, { obligation, expectedVersion: 1, expectedPaidMinor: "0", facts: noFacts, consent: null }))
      .toMatchObject({ ok: false, refusal: { code: "automation_cannot_amend" } })
  })

  it("moves actual received money once, with no extra cash or weakening of applications", () => {
    const unallocated = position(after, dkk("200"), "0", true)
    const allocated = position(after, dkk("200"), dkk("200"), true)
    expect(unallocated).toMatchObject({ ok: true, position: { receivableMinor: 100000n, advanceAvailableMinor: 20000n, remainingMinor: 80000n } })
    expect(allocated).toMatchObject({ ok: true, position: { receivableMinor: 80000n, advanceAvailableMinor: 0n, advanceAppliedMinor: 20000n, remainingMinor: 80000n } })
    expect(position(after, dkk("200"), dkk("500"))).toMatchObject({ ok: false, refusals: [{ code: "over_application" }] })
  })

  it("returns gross potential requests, not an aggregate cash balance", () => {
    expect(dueEntries(before, obligation).map((entry) => entry.amount)).toEqual([50000n, 100000n])
    expect(dueEntries(after, obligation).map((entry) => entry.amount)).toEqual([50000n, 50000n, 50000n])
  })
})

describe("advance authority must cover potentially unpaid sales", () => {
  const authority: CollectionAuthority = { authorityId: "authority", version: 1, status: "active", scope: { kind: "plan", planId: before.planId, version: 1 }, currency: "DKK", maxChargeMinor: dkk("500"), minDaysBetweenCharges: 0, consentEvidenceRef: "synthetic" }

  it("checks the full sale against the maximum even when an advance was requested", () => {
    expect(planAmendmentImpact(before, before, obligation, noFacts, authority).authority)
      .toEqual({ renewalRequired: true, reasons: ["A charge exceeds the authorized maximum"] })
  })

  it("includes a sale date formerly zeroed by the advance in spacing checks", () => {
    expect(planAmendmentImpact(after, after, obligation, noFacts, { ...authority, minDaysBetweenCharges: 7 }).authority)
      .toEqual({ renewalRequired: true, reasons: ["Charges are closer together than authorized"] })
    expect(planAmendmentImpact(after, after, obligation, noFacts, authority).authority)
      .toEqual({ renewalRequired: false, reasons: [] })
  })
})
