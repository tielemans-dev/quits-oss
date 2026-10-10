import { describe, expect, it } from "vitest"
import { consentReasons, noFacts } from "../amendment"
import { adoptPlan, emptyPlanState, withdrawPending } from "../authority"
import type { BillingStep, PlanVersion } from "../model"
import { validatePlan } from "../validate"
import { agreementObligation, dkk, onAccepted, plan, shareStep } from "./fixtures"

const obligation = agreementObligation({ agreementId: "agr_events", acceptedOn: "2026-10-01", lines: ["X", "Y", "Z", "W"].map((id) => ({ id, net: "7500" })) })
const half = dkk("18750")
const current = plan(obligation, { kind: "billing_steps", steps: [
  shareStep("d", half, { kind: "on_date", date: "2026-10-01" }, 0), shareStep("f", half, onAccepted("Z")),
] })
const proposed = plan(obligation, { kind: "billing_steps", steps: [shareStep("x", half, onAccepted("X")), shareStep("y", half, onAccepted("Y"))] })
const offerConsent = { kind: "offer_acceptance" as const, offerRevision: 1, acceptedOn: "2026-10-01" }
const context = { obligation, expectedPaidMinor: "0", facts: noFacts }

function amend(before: PlanVersion, after: PlanVersion) {
  expect(validatePlan(obligation, before)).toEqual([])
  expect(validatePlan(obligation, after)).toEqual([])
  const initial = adoptPlan(emptyPlanState(before.planId, obligation), before, { ...context, expectedVersion: null, consent: offerConsent })
  if (!initial.ok) throw new Error(initial.refusal.detail)
  const next = { ...after, version: 2, supersedes: 1, source: "seller_amendment" as const, actor: { kind: "user" as const, id: "seller" }, reason: "Reschedule" }
  const result = adoptPlan(initial.state, next, { ...context, expectedVersion: 1, consent: null })
  if (!result.ok) throw new Error(result.refusal.detail)
  return { initial, next, result }
}

// Evaluate concrete event histories, independently of the dominance algorithm.
function dueInWorld(version: PlanVersion, events: Record<string, { delivered: string; accepted?: string }>, today: string) {
  if (version.arrangement.kind !== "billing_steps") throw new Error("Billing fixture required")
  return version.arrangement.steps.reduce((total, step) => {
    const trigger = step.trigger
    const date = trigger.kind === "on_date" ? trigger.date : trigger.kind === "on_acceptance" ? obligation.effectiveOn
      : trigger.deliverableIds.reduce<string | undefined>((latest, id) => {
        const occurred = events[id]?.[trigger.event]
        return latest === undefined || occurred === undefined ? undefined : occurred > latest ? occurred : latest
      }, obligation.effectiveOn)
    if (date === undefined) return total
    const due = new Date(`${date}T00:00:00Z`)
    due.setUTCDate(due.getUTCDate() + step.dueInDays)
    return due.toISOString().slice(0, 10) <= today ? total + BigInt(step.grossMinor) : total
  }, 0n)
}

function schedule(steps: BillingStep[]) {
  return plan(obligation, { kind: "billing_steps", steps })
}

function requiresConsent(before: PlanVersion, after: PlanVersion) {
  expect(consentReasons(before, after, obligation).length).toBeGreaterThan(0)
  const { initial, next, result } = amend(before, after)
  expect(result.outcome).toBe("awaiting_consent")
  expect(result.state.current).toEqual(initial.state.current)
  expect(result.state.pending).toEqual(next)
  return result
}

describe("consent across combined event payments", () => {
  it("holds the combined X/Y ask while Z has not happened (M1)", () => {
    const events = { X: { delivered: "2026-10-02", accepted: "2026-10-02" }, Y: { delivered: "2026-10-03", accepted: "2026-10-03" } }
    expect(dueInWorld(current, events, "2026-10-17")).toBe(1875000n)
    expect(dueInWorld(proposed, events, "2026-10-17")).toBe(3750000n)
    requiresConsent(current, proposed)
  })

  it("also holds the reverse edit when X/Y have not happened", () => {
    expect(dueInWorld(proposed, {}, "2026-10-01")).toBe(0n)
    expect(dueInWorld(current, {}, "2026-10-01")).toBe(1875000n)
    requiresConsent(proposed, current)
  })

  it.each([2, 3])("checks a union of %i among three independent new events", (count) => {
    const third = dkk("12500")
    const before = schedule([shareStep("d", third, { kind: "on_date", date: "2026-10-01" }, 0), shareStep("w", dkk("25000"), onAccepted("W"))])
    const after = schedule(["X", "Y", "Z"].map((id) => shareStep(id, third, onAccepted(id))))
    const events = Object.fromEntries(["X", "Y", "Z"].slice(0, count).map((id) => [id, { delivered: "2026-10-02", accepted: "2026-10-02" }]))
    expect(dueInWorld(after, events, "2026-10-16") - dueInWorld(before, events, "2026-10-16")).toBe(BigInt(third) * BigInt(count - 1))
    requiresConsent(before, after)
    requiresConsent(after, before)
  })

  it("checks combined delivery and acceptance with different payment terms", () => {
    const after = schedule([
      shareStep("x", half, { kind: "on_deliverables", event: "delivered", deliverableIds: ["X"] }, 30),
      shareStep("y", half, onAccepted("Y"), 7),
    ])
    const events = { X: { delivered: "2026-10-02" }, Y: { delivered: "2026-10-02", accepted: "2026-10-25" } }
    expect(dueInWorld(after, events, "2026-11-01") - dueInWorld(current, events, "2026-11-01")).toBe(1875000n)
    requiresConsent(current, after)
    requiresConsent(after, current)
  })

  it("keeps a declined combined-event amendment and the original acceptance in history", () => {
    const result = requiresConsent(current, proposed)
    const declined = withdrawPending(result.state)
    expect(declined.current).toEqual(result.state.current)
    expect(declined.current?.consent).toEqual(offerConsent)
    expect(declined.pending).toBeNull()
    expect(declined.history).toMatchObject([{ plan: { version: 2 }, consent: null, outcome: "withdrawn" }])
    expect(declined.nextVersion).toBe(3)
  })

  it("refuses changing an issued step even when consent could be recorded", () => {
    const { initial, next } = amend(current, proposed)
    expect(adoptPlan(initial.state, next, { ...context, expectedVersion: 1, consent: { kind: "customer_consent", evidenceRef: "consent", recordedOn: "2026-10-03" }, facts: { ...noFacts, documents: [{ targetId: "d", invoiceId: "INV-frozen", status: "issued" }] } }))
      .toMatchObject({ ok: false, refusal: { code: "issued_step_immutable" } })
  })

  it("adopts independent event deferrals without consent", () => {
    if (proposed.arrangement.kind !== "billing_steps") throw new Error("Billing fixture required")
    const deferred = schedule(proposed.arrangement.steps.map((step) => ({ ...step, dueInDays: 30 })))
    expect(consentReasons(proposed, deferred, obligation)).toEqual([])
    const { result, initial } = amend(proposed, deferred)
    expect(result.outcome).toBe("authoritative")
    expect(result.state.current?.consent).toEqual({ kind: "not_required", notifyCustomer: true })
    expect(result.state.history).toEqual([{ ...initial.state.current, outcome: "superseded" }])
    requiresConsent(deferred, proposed)
  })

  it("proves redistributions and conjunctions by using each old amount only once", () => {
    const before = schedule([shareStep("x", half, onAccepted("X")), shareStep("y", half, onAccepted("Y"))])
    const after = schedule([shareStep("xy", dkk("37500"), onAccepted("X", "Y"), 30)])
    expect(consentReasons(before, after, obligation)).toEqual([])
    expect(amend(before, after).result.outcome).toBe("authoritative")
    requiresConsent(after, before)
  })

  it("can reassign earlier money to preserve a favourable split regardless of step order", () => {
    const before = schedule([shareStep("date", half, { kind: "on_date", date: "2026-10-01" }, 0), shareStep("x", half, onAccepted("X"))])
    // A greedy match of date to x would leave no capacity that can cover y.
    const after = schedule([shareStep("x", half, onAccepted("X"), 30), shareStep("y", half, onAccepted("Y"), 30)])
    expect(consentReasons(before, after, obligation)).toEqual([])
    expect(amend(before, after).result.outcome).toBe("authoritative")
  })

  it("requires consent conservatively when dominance needs a joint-event proof", () => {
    const before = schedule([shareStep("date", half, { kind: "on_date", date: "2026-10-01" }, 0), shareStep("xy", half, onAccepted("X", "Y"))])
    // Together X/Y imply the old conjunction is due, but neither payment alone implies it.
    // The capacity proof deliberately declines to infer this more precise union relationship.
    requiresConsent(before, proposed)
  })

  it("proves a large identical event plan without enumerating its event combinations", () => {
    const steps = Array.from({ length: 60 }, (_, i) => shareStep(`s${i}`, dkk("625"), onAccepted(["X", "Y", "Z", "W"][i % 4]!), i))
    const before = schedule(steps)
    const after = schedule([...steps].reverse().map((step) => ({ ...step, dueInDays: step.dueInDays + 1 })))
    expect(consentReasons(before, after, obligation)).toEqual([])
    expect(amend(before, after).result.outcome).toBe("authoritative")
  })
})
