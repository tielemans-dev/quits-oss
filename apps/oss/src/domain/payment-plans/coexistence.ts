import { refuse, type PlanRefusal } from "./model"

/**
 * What a billing or collection instruction claims. Keys are owner identities such as
 * `agreement:<id>`, `invoice:<id>`, `recurring:<id>` or `plan:<id>`.
 */
export type InstructionClaim =
  | { kind: "billing_plan"; id: string; obligationKey: string }
  | { kind: "collection_plan"; id: string; invoiceKey: string; invoiceBillsObligationKey: string | null }
  | { kind: "recurring"; id: string; instructionKey: string; billsObligationKey: string | null }
  | { kind: "authority"; id: string; scopeKey: string }

export type Relation = { relation: "independent" | "layered" | "duplicate"; refusal: PlanRefusal | null }
const independent: Relation = { relation: "independent", refusal: null }
const layered: Relation = { relation: "layered", refusal: null }
const duplicate = (refusal: PlanRefusal): Relation => ({ relation: "duplicate", refusal })

/**
 * How two instructions relate. Duplicate: both would decide how the same obligation is billed or
 * collected. Layered: one acts on the other's output (collecting one invoice of a billing plan,
 * or an authority to pull money for a plan). Independent: different obligations.
 */
export function relate(a: InstructionClaim, b: InstructionClaim): Relation {
  const recurringSplit = [a, b].find((claim) => claim.kind === "recurring" && claim.billsObligationKey !== null)
  if (recurringSplit) return duplicate(refuse("recurring_cannot_split_fixed_obligation", `${recurringSplit.id} would bill a fixed obligation by recurrence; use billing steps on that obligation instead`))
  if (a.kind === "billing_plan" && b.kind === "billing_plan")
    return a.obligationKey === b.obligationKey ? duplicate(refuse("plan_already_authoritative", `${a.id} and ${b.id} both split ${a.obligationKey}`)) : independent
  if (a.kind === "collection_plan" && b.kind === "collection_plan")
    return a.invoiceKey === b.invoiceKey ? duplicate(refuse("plan_already_authoritative", `${a.id} and ${b.id} both schedule ${a.invoiceKey}`)) : independent
  if (a.kind === "authority" && b.kind === "authority")
    return a.scopeKey === b.scopeKey ? duplicate(refuse("duplicate_instruction", `${a.id} and ${b.id} both authorize charges for ${a.scopeKey}`)) : independent
  const pair = [a, b]
  const billing = pair.find((claim) => claim.kind === "billing_plan"), collection = pair.find((claim) => claim.kind === "collection_plan")
  if (billing?.kind === "billing_plan" && collection?.kind === "collection_plan")
    return collection.invoiceBillsObligationKey === billing.obligationKey ? layered : independent
  const authority = pair.find((claim) => claim.kind === "authority"), other = pair.find((claim) => claim.kind !== "authority")
  if (authority?.kind === "authority" && other) {
    const key = other.kind === "recurring" ? other.instructionKey : `plan:${other.id}`
    return key === authority.scopeKey ? layered : independent
  }
  return independent
}

/** Every invalid claim and duplicate pair in a set. An empty result means the set can coexist. */
export function conflicts(claims: InstructionClaim[]) {
  const found: Array<{ a: string; b: string; refusal: PlanRefusal }> = []
  for (const claim of claims)
    if (claim.kind === "recurring" && claim.billsObligationKey !== null)
      found.push({ a: claim.id, b: claim.id, refusal: refuse("recurring_cannot_split_fixed_obligation", `${claim.id} would bill ${claim.billsObligationKey} by recurrence`) })
  claims.forEach((a, index) => {
    for (const b of claims.slice(index + 1)) {
      const { refusal } = relate(a, b)
      if (refusal && refusal.code !== "recurring_cannot_split_fixed_obligation") found.push({ a: a.id, b: b.id, refusal })
    }
  })
  return found
}
