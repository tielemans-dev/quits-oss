import { addUtcDays, formatCalendarDate, parseCalendarDate } from "../features/recurring-dates"
import { planAmendmentImpact, type AmendmentImpact, type PlanFacts } from "./amendment"
import { refuse, type Consent, type Obligation, type PlanRef, type PlanRefusal, type PlanVersion } from "./model"
import { compareObligationRef, obligationKey, validatePlan } from "./validate"

/**
 * The single authoritative plan of one obligation, its history and at most one amendment
 * waiting for customer consent. Persisted, this is one plan row per obligation (unique on the
 * obligation) with append-only versions; `current` changes only by compare-and-set on its
 * version, under the same document lock the obligation's commands already take.
 */
export type PlanState = {
  planId: string
  obligationKey: string
  current: { plan: PlanVersion; consent: Consent } | null
  pending: PlanVersion | null
  /** Superseded and withdrawn versions, oldest first. Never deleted, never reused. */
  history: Array<{ plan: PlanVersion; consent: Consent | null; outcome: "superseded" | "withdrawn" }>
  nextVersion: number
}
export const emptyPlanState = (planId: string, obligation: Obligation): PlanState =>
  ({ planId, obligationKey: obligationKey(obligation.ref), current: null, pending: null, history: [], nextVersion: 1 })

/**
 * An invoice is collected in full on its due date until a collection plan says otherwise. This
 * implicit plan is never stored; the first explicit collection plan is version 1 and amends it.
 */
export function implicitCollectionPlan(obligation: Obligation, planId: string): PlanVersion | null {
  if (obligation.ref.kind !== "invoice" || !obligation.dueDate) return null
  return {
    planId, version: 1, supersedes: null, obligation: obligation.ref, currency: obligation.currency,
    arrangement: { kind: "collection_installments", installments: [{ installmentId: "due", grossMinor: obligation.grossMinor, dueDate: obligation.dueDate }] },
    source: "seller_amendment", actor: { kind: "migration", id: "implicit" }, reason: "Implicit: the invoice's own due date",
  }
}

export type AdoptContext = {
  obligation: Obligation
  /** The version the proposer saw as current (null: none). A mismatch means someone else won. */
  expectedVersion: number | null
  /** The paid amount the proposer saw, for collection plans. A mismatch means a payment landed. */
  expectedPaidMinor: string
  facts: PlanFacts
  /** Offer acceptance for version 1, or recorded customer consent for an amendment that needs it. */
  consent: Consent | null
}
export type AdoptResult =
  | { ok: true; state: PlanState; outcome: "authoritative" | "awaiting_consent"; impact: AmendmentImpact | null }
  | { ok: false; refusal: PlanRefusal }

/**
 * Proposes `plan` as the obligation's next version. Two proposals built on the same version can
 * never both win: the second sees a different current version, or a pending amendment, and is
 * refused. Automations only ever reference a plan; they cannot propose one.
 */
export function adoptPlan(state: PlanState, plan: PlanVersion, context: AdoptContext): AdoptResult {
  const fail = (refusal: PlanRefusal): AdoptResult => ({ ok: false, refusal })
  if (plan.actor.kind === "automation") return fail(refuse("automation_cannot_amend", "Automations reference the canonical plan; a person or the customer changes it"))
  if (obligationKey(context.obligation.ref) !== state.obligationKey) return fail(refuse("obligation_mismatch", "The state belongs to another obligation"))
  if (plan.planId !== state.planId) return fail(refuse("plan_already_authoritative", "This obligation already has its canonical plan; amend it instead of attaching another"))
  const invalid = validatePlan(context.obligation, plan)
  if (invalid.length) return fail(invalid[0]!)
  const currentVersion = state.current?.plan.version ?? null
  if (context.expectedVersion !== currentVersion)
    return fail(refuse("stale_plan_version", `Built on version ${context.expectedVersion ?? "none"}, but version ${currentVersion ?? "none"} is current`))
  if (state.pending) return fail(refuse("amendment_pending", `Version ${state.pending.version} is waiting for customer consent; record or withdraw it first`))
  if (plan.version !== state.nextVersion || plan.supersedes !== currentVersion)
    return fail(refuse("version_sequence", `Expected version ${state.nextVersion} superseding ${currentVersion ?? "none"}`))
  if (context.expectedPaidMinor !== context.facts.paidMinor)
    return fail(refuse("stale_settlement", "A payment was recorded since this version was prepared; review the new balance"))

  const base = state.current?.plan ?? implicitCollectionPlan(context.obligation, state.planId)
  if (!base) {
    // An agreement's first version is the schedule the customer accepted with the offer.
    if (plan.source !== "agreement_offer" && plan.source !== "migration")
      return fail(refuse("version_sequence", "An agreement's first plan comes from its accepted offer"))
    const ref = context.obligation.ref
    if (context.consent?.kind !== "offer_acceptance" || ref.kind !== "agreement_services" || context.consent.offerRevision !== ref.offerRevision)
      return fail(refuse("consent_does_not_match", "Version 1 needs the acceptance of the offer revision it was built from"))
    return { ok: true, outcome: "authoritative", impact: null, state: { ...state, current: { plan, consent: context.consent }, nextVersion: plan.version + 1 } }
  }

  const impact = planAmendmentImpact(base, plan, context.obligation, context.facts)
  if (impact.refusals.length) return fail(impact.refusals[0]!)
  const consented = context.consent?.kind === "customer_consent"
  if (impact.consent.required && !consented)
    return { ok: true, outcome: "awaiting_consent", impact, state: { ...state, pending: plan, nextVersion: plan.version + 1 } }
  const consent: Consent = consented ? context.consent! : { kind: "not_required", notifyCustomer: impact.notifyCustomer }
  return { ok: true, outcome: "authoritative", impact, state: supersede(state, plan, consent) }
}

function supersede(state: PlanState, plan: PlanVersion, consent: Consent): PlanState {
  return {
    ...state, current: { plan, consent }, pending: null, nextVersion: Math.max(state.nextVersion, plan.version + 1),
    history: state.current ? [...state.history, { ...state.current, outcome: "superseded" }] : state.history,
  }
}

/** The customer agreed to the pending version. Refused if anything moved meanwhile. */
export function recordConsent(state: PlanState, input: { version: number; expectedCurrentVersion: number | null; consent: Consent; obligation: Obligation; facts: PlanFacts }) {
  const pending = state.pending
  if (!pending || pending.version !== input.version) return { ok: false as const, refusal: refuse("no_pending_amendment", `Version ${input.version} is not waiting for consent`) }
  if ((state.current?.plan.version ?? null) !== input.expectedCurrentVersion) return { ok: false as const, refusal: refuse("stale_plan_version", "The current version changed") }
  if (input.consent.kind !== "customer_consent") return { ok: false as const, refusal: refuse("consent_does_not_match", "An amendment needs recorded customer consent") }
  const stale = compareObligationRef(pending.obligation, input.obligation.ref)
  if (stale) return { ok: false as const, refusal: stale }
  // Payments or issuance may have landed while the customer was deciding.
  const base = state.current?.plan ?? implicitCollectionPlan(input.obligation, state.planId)
  const impact = base ? planAmendmentImpact(base, pending, input.obligation, input.facts) : null
  if (impact?.refusals.length) return { ok: false as const, refusal: impact.refusals[0]! }
  return { ok: true as const, impact, state: supersede(state, pending, input.consent) }
}

/** The seller withdraws a pending amendment. Its version number is never reused. */
export function withdrawPending(state: PlanState): PlanState {
  if (!state.pending) return state
  return { ...state, pending: null, history: [...state.history, { plan: state.pending, consent: null, outcome: "withdrawn" }] }
}

/** Editors, invoice lines and automations hold a reference; it must name the current version. */
export function checkPlanRef(state: PlanState, ref: PlanRef): PlanRefusal | null {
  const current = state.current?.plan
  if (!current || ref.planId !== state.planId || ref.version !== current.version)
    return refuse("stale_plan_reference", `The reference names ${ref.planId} v${ref.version}; the current plan is ${current ? `v${current.version}` : "missing"}`)
  if (ref.stepId === undefined) return null
  const arrangement = current.arrangement
  const ids = arrangement.kind === "collection_installments"
    ? arrangement.installments.map((item) => item.installmentId)
    : [...arrangement.steps.map((step) => step.stepId), ...(arrangement.kind === "advance_then_billing" ? arrangement.advances.map((advance) => advance.advanceId) : [])]
  return ids.includes(ref.stepId) ? null : refuse("stale_plan_reference", `Step ${ref.stepId} is not in the current version`)
}

/**
 * The documented exception rule for one draft raised from a billing step. A draft may differ from
 * its step only in terms that do not move money earlier or redistribute the obligation: a later
 * due date, notes and references. Extra unlinked lines are a separate obligation. A different
 * linked amount, or an earlier due date without consent, is a plan amendment, never an exception.
 */
export function classifyStepDraft(input: {
  stepGrossMinor: string
  /** When the step's trigger occurred (acceptance, the date, or the deliverable event). */
  triggeredOn: string
  dueInDays: number
  draft: { linkedGrossMinor: string; dueDate: string; unlinkedLines: number }
  consent: Consent | null
  reason: string | null
}): { ok: true; exceptions: Array<{ kind: "later_due_date" | "separate_obligation_lines"; detail: string }> } | { ok: false; refusal: PlanRefusal } {
  if (input.draft.linkedGrossMinor !== input.stepGrossMinor)
    return { ok: false, refusal: refuse("amount_requires_plan_amendment", "Change how much a step bills by amending the plan") }
  const planned = formatCalendarDate(addUtcDays(parseCalendarDate(input.triggeredOn), input.dueInDays))
  if (input.draft.dueDate < planned && input.consent?.kind !== "customer_consent")
    return { ok: false, refusal: refuse("earlier_due_requires_consent", `The plan makes this due on ${planned}`) }
  const exceptions: Array<{ kind: "later_due_date" | "separate_obligation_lines"; detail: string }> = []
  if (input.draft.dueDate > planned) {
    if (!input.reason) return { ok: false, refusal: refuse("exception_reason_required", "A later due date than planned needs a recorded reason") }
    exceptions.push({ kind: "later_due_date", detail: `Due ${input.draft.dueDate} instead of ${planned}: ${input.reason}` })
  }
  if (input.draft.unlinkedLines > 0)
    exceptions.push({ kind: "separate_obligation_lines", detail: `${input.draft.unlinkedLines} unlinked line(s) bill something outside the plan's obligation` })
  return { ok: true, exceptions }
}
