import { requireCurrencyExponent } from "@quits/shared/currency"
import { moneyMinor } from "@quits/shared/pricing"
import { sumMinor } from "./amounts"
import { refuse, type BillingStep, type Obligation, type ObligationRef, type PlanRefusal, type PlanVersion, type StepTrigger } from "./model"

export const obligationKey = (ref: ObligationRef) => ref.kind === "agreement_services" ? `agreement:${ref.agreementId}` : `invoice:${ref.invoiceId}`

/** Same owner and same version. A different version of the same owner is stale, not foreign. */
export function compareObligationRef(plan: ObligationRef, current: ObligationRef): PlanRefusal | null {
  if (obligationKey(plan) !== obligationKey(current)) return refuse("obligation_mismatch", "The plan belongs to another obligation")
  const same = plan.kind === "agreement_services" && current.kind === "agreement_services"
    ? plan.offerRevision === current.offerRevision && plan.offerSnapshotHash === current.offerSnapshotHash
    : plan.kind === "invoice" && current.kind === "invoice" && plan.issuedArtifactHash === current.issuedArtifactHash
  return same ? null : refuse("stale_obligation_version", "The plan was built from an older version of the obligation")
}

/** What the plan must bill: the accepted total less cancelled scope lines. */
export function billableGross(obligation: Obligation) {
  const cancelled = obligation.deliverables.filter((line) => line.kind === "scope" && line.cancelled)
  return BigInt(obligation.grossMinor) - sumMinor(cancelled.map((line) => line.grossMinor))
}

function checkTrigger(obligation: Obligation, trigger: StepTrigger, where: string): PlanRefusal | null {
  if (trigger.kind === "on_date" && trigger.date < obligation.effectiveOn)
    return refuse("date_before_obligation", `${where} is dated before the obligation became binding`)
  if (trigger.kind !== "on_deliverables") return null
  for (const id of trigger.deliverableIds) {
    const line = obligation.deliverables.find((candidate) => candidate.deliverableId === id)
    if (!line) return refuse("unknown_deliverable", `${where} waits for an unknown deliverable ${id}`)
    if (line.kind !== "scope" || !line.fulfillable || line.cancelled)
      return refuse("trigger_not_fulfillable", `${where} waits for ${id}, which is never delivered`)
  }
  return null
}

function checkSteps(obligation: Obligation, steps: BillingStep[]): PlanRefusal | null {
  if (new Set(steps.map((step) => step.stepId)).size !== steps.length) return refuse("duplicate_step", "Step ids must be unique")
  const sources = new Set(steps.map((step) => step.source.kind))
  if (sources.size > 1) return refuse("mixed_step_sources", "A plan bills either deliverables or shares of the total, not both")
  if (sources.has("share")) {
    if (!obligation.vatGroups.length) return refuse("vat_groups_unavailable", "Shares need the obligation's frozen VAT groups")
    if (obligation.deliverables.some((line) => line.kind === "scope" && line.cancelled))
      return refuse("stale_obligation_version", "Cancelled scope changes the VAT groups; amend the agreement first")
  }
  const billed = new Set<string>()
  for (const step of steps) {
    if (step.source.kind === "deliverable") {
      const id = step.source.deliverableId
      const line = obligation.deliverables.find((candidate) => candidate.deliverableId === id)
      if (!line) return refuse("unknown_deliverable", `Step ${step.stepId} bills an unknown deliverable`)
      if (line.kind !== "scope" || line.cancelled)
        return refuse("deliverable_not_scope", `Step ${step.stepId} bills ${id}, which is not billable scope`)
      if (billed.has(id)) return refuse("duplicate_step", `Deliverable ${id} is billed twice`)
      if (line.grossMinor !== step.grossMinor) return refuse("total_mismatch", `Step ${step.stepId} must bill the frozen line value`)
      billed.add(id)
    }
    const trigger = checkTrigger(obligation, step.trigger, `Step ${step.stepId}`)
    if (trigger) return trigger
  }
  if (sumMinor(steps.map((step) => step.grossMinor)) !== billableGross(obligation))
    return refuse("total_mismatch", "Billing steps must bill the obligation exactly once")
  return null
}

/** Pure structural validation of one version against the obligation it names. */
export function validatePlan(obligation: Obligation, plan: PlanVersion): PlanRefusal[] {
  const refusals: PlanRefusal[] = []
  try {
    requireCurrencyExponent(obligation.currency)
  } catch {
    return [refuse("currency_unsupported", `${obligation.currency} has no supported minor unit`)]
  }
  if (plan.currency !== obligation.currency) refusals.push(refuse("currency_mismatch", "A plan uses the obligation's currency"))
  const reference = compareObligationRef(plan.obligation, obligation.ref)
  if (reference) refusals.push(reference)
  const sumScope = sumMinor(obligation.deliverables.filter((line) => line.kind === "scope").map((line) => line.grossMinor))
  if (obligation.deliverables.length && sumScope !== BigInt(obligation.grossMinor))
    refusals.push(refuse("stale_obligation_version", "Scope lines do not add up to the obligation"))
  const exponent = requireCurrencyExponent(obligation.currency)
  if (obligation.vatGroups.some((group) => BigInt(moneyMinor(group.gross, exponent)) < 0n) ||
      (obligation.vatGroups.length && sumMinor(obligation.vatGroups.map((group) => moneyMinor(group.gross, exponent))) !== BigInt(obligation.grossMinor)))
    refusals.push(refuse("stale_obligation_version", "Frozen VAT groups do not add up to the obligation"))

  const arrangement = plan.arrangement
  const agreement = obligation.ref.kind === "agreement_services"
  if (agreement === (arrangement.kind === "collection_installments"))
    return [...refusals, refuse("arrangement_not_allowed", `${arrangement.kind} does not apply to a ${obligation.ref.kind} obligation`)]
  if (arrangement.kind === "billing_steps") {
    const steps = checkSteps(obligation, arrangement.steps)
    if (steps) refusals.push(steps)
  } else if (arrangement.kind === "advance_then_billing") {
    const steps = checkSteps(obligation, arrangement.steps)
    if (steps) refusals.push(steps)
    const ids = arrangement.advances.map((advance) => advance.advanceId)
    if (new Set(ids).size !== ids.length || ids.some((id) => arrangement.steps.some((step) => step.stepId === id)))
      refusals.push(refuse("duplicate_step", "Advance ids must be unique within the plan"))
    for (const advance of arrangement.advances) {
      const trigger = checkTrigger(obligation, advance.trigger, `Advance ${advance.advanceId}`)
      if (trigger) refusals.push(trigger)
    }
    if (sumMinor(arrangement.advances.map((advance) => advance.grossMinor)) > billableGross(obligation))
      refusals.push(refuse("advance_exceeds_obligation", "Advances cannot request more than the obligation"))
  } else {
    const installments = arrangement.installments
    if (new Set(installments.map((installment) => installment.installmentId)).size !== installments.length)
      refusals.push(refuse("duplicate_step", "Installment ids must be unique"))
    if (installments.some((installment, index) => index > 0 && installment.dueDate <= installments[index - 1]!.dueDate))
      refusals.push(refuse("dates_not_increasing", "Installment due dates must strictly increase"))
    if (installments[0]!.dueDate < obligation.effectiveOn)
      refusals.push(refuse("date_before_obligation", "The first installment is due before the invoice was issued"))
    if (sumMinor(installments.map((installment) => installment.grossMinor)) !== BigInt(obligation.grossMinor))
      refusals.push(refuse("total_mismatch", "Installments must total the invoice's payable gross"))
  }
  return refusals
}
