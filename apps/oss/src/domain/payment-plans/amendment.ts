import { addUtcDays, formatCalendarDate, parseCalendarDate } from "../features/recurring-dates"
import { formatMinor } from "./amounts"
import { refuse, type CollectionAuthority, type Obligation, type PlanRefusal, type PlanVersion, type StepTrigger } from "./model"

/** Facts about one obligation's documents and money that an amendment must respect. */
export type PlanFacts = {
  /** Invoices raised from billing steps, keyed by step id. */
  documents: Array<{ targetId: string; invoiceId: string; status: "draft" | "issued" }>
  /** Advance money already received, by advance id. */
  advanceReceipts: Array<{ advanceId: string; grossMinor: string }>
  /** Receipts allocated to the invoice of a collection plan, as currently recorded. */
  paidMinor: string
  /** Unsent reminders keyed to a step, advance or installment. */
  reminders: Array<{ reminderId: string; targetId: string }>
}
export const noFacts: PlanFacts = { documents: [], advanceReceipts: [], paidMinor: "0", reminders: [] }

/**
 * When money falls due. Dates compare by calendar. A deliverable event happens on or after the
 * obligation became binding, so a date is no later than an event due `days` after it when it is
 * no later than the obligation date plus those days. An event only precedes another event on a
 * superset of its deliverables, at the same or a later stage and term, and never precedes a date.
 */
type DueKey = { kind: "date"; date: string } | { kind: "event"; deliverableIds: string[]; rank: number; days: number; earliest: string }
type DueEntry = { targetId: string; key: DueKey; amount: bigint }
type Target = { targetId: string; grossMinor: bigint; terms: string }

const dateKey = (date: string, days: number): DueKey & { kind: "date" } => ({ kind: "date", date: formatCalendarDate(addUtcDays(parseCalendarDate(date), days)) })
function dueKey(obligation: Obligation, trigger: StepTrigger, dueInDays: number): DueKey {
  if (trigger.kind === "on_acceptance") return dateKey(obligation.effectiveOn, dueInDays)
  if (trigger.kind === "on_date") return dateKey(trigger.date, dueInDays)
  return { kind: "event", deliverableIds: [...trigger.deliverableIds].sort(), rank: trigger.event === "delivered" ? 0 : 1, days: dueInDays, earliest: dateKey(obligation.effectiveOn, dueInDays).date }
}
/** `a` is due no later than `b`, however events turn out. */
function noLater(a: DueKey, b: DueKey) {
  if (a.kind === "date") return a.date <= (b.kind === "date" ? b.date : b.earliest)
  return b.kind === "event" && a.deliverableIds.every((id) => b.deliverableIds.includes(id)) && a.rank <= b.rank && a.days <= b.days
}
const describeKey = (key: DueKey) => key.kind === "date" ? key.date : `${key.rank ? "acceptance" : "delivery"} of ${key.deliverableIds.join("+")} + ${key.days} days`

function targetsOf(plan: PlanVersion): Target[] {
  const arrangement = plan.arrangement
  if (arrangement.kind === "collection_installments")
    return arrangement.installments.map((item) => ({ targetId: item.installmentId, grossMinor: BigInt(item.grossMinor), terms: item.dueDate }))
  const steps = arrangement.steps.map((step) => ({ targetId: step.stepId, grossMinor: BigInt(step.grossMinor), terms: JSON.stringify([step.source, step.trigger, step.dueInDays]) }))
  if (arrangement.kind === "billing_steps") return steps
  return [...arrangement.advances.map((advance) => ({ targetId: advance.advanceId, grossMinor: BigInt(advance.grossMinor), terms: JSON.stringify(["advance", advance.trigger, advance.dueInDays]) })), ...steps]
}

/**
 * What the customer is asked to pay, and when. Advances are applied to the next sale invoices in
 * plan order, so a sale step asks only for what the advance pool has not already covered.
 */
export function dueEntries(plan: PlanVersion, obligation: Obligation): DueEntry[] {
  const arrangement = plan.arrangement
  if (arrangement.kind === "collection_installments")
    return arrangement.installments.map((item) => ({ targetId: item.installmentId, key: dateKey(item.dueDate, 0), amount: BigInt(item.grossMinor) }))
  let pool = arrangement.kind === "advance_then_billing" ? arrangement.advances.reduce((total, advance) => total + BigInt(advance.grossMinor), 0n) : 0n
  const advances = arrangement.kind === "advance_then_billing"
    ? arrangement.advances.map((advance) => ({ targetId: advance.advanceId, key: dueKey(obligation, advance.trigger, advance.dueInDays), amount: BigInt(advance.grossMinor) }))
    : []
  return [...advances, ...arrangement.steps.map((step) => {
    const applied = pool < BigInt(step.grossMinor) ? pool : BigInt(step.grossMinor)
    pool -= applied
    return { targetId: step.stepId, key: dueKey(obligation, step.trigger, step.dueInDays), amount: BigInt(step.grossMinor) - applied }
  })]
}

/**
 * Prove dominance for every event combination by assigning each new minor unit to an old minor
 * unit guaranteed due no later. Old capacity can only be used once. This is a sufficient proof:
 * any set of new payments due in a realized history has at least as much distinct old money due.
 * When no assignment exists we require consent, even if a more precise event proof might work.
 * Breadth-first residual paths allow reassignment without enumerating event subsets. Edmonds-Karp
 * takes O(V E²) time and O(V + E) space, independent of the numeric amounts.
 */
function coveredByEarlierMoney(before: DueEntry[], after: DueEntry[]) {
  type Edge = { to: number; reverse: number; capacity: bigint }
  const source = before.length + after.length, sink = source + 1
  const graph: Edge[][] = Array.from({ length: sink + 1 }, () => [])
  const connect = (from: number, to: number, capacity: bigint) => {
    graph[from]!.push({ to, reverse: graph[to]!.length, capacity })
    graph[to]!.push({ to: from, reverse: graph[from]!.length - 1, capacity: 0n })
  }
  const required = after.reduce((total, entry) => total + entry.amount, 0n)
  before.forEach((entry, i) => {
    connect(source, i, entry.amount)
    after.forEach((next, j) => {
      if (noLater(entry.key, next.key)) connect(i, before.length + j, required)
    })
  })
  after.forEach((entry, j) => connect(before.length + j, sink, entry.amount))
  let covered = 0n
  while (covered < required) {
    const parents: Array<{ from: number; edge: number } | undefined> = Array(graph.length)
    const visited = new Set([source]), queue = [source]
    for (let cursor = 0; cursor < queue.length && !visited.has(sink); cursor++) {
      const from = queue[cursor]!
      graph[from]!.forEach((edge, index) => {
        if (edge.capacity > 0n && !visited.has(edge.to)) {
          visited.add(edge.to)
          parents[edge.to] = { from, edge: index }
          queue.push(edge.to)
        }
      })
    }
    if (!visited.has(sink)) return false
    let amount = required - covered
    for (let node = sink; node !== source;) {
      const parent = parents[node]!, edge = graph[parent.from]![parent.edge]!
      if (edge.capacity < amount) amount = edge.capacity
      node = parent.from
    }
    for (let node = sink; node !== source;) {
      const parent = parents[node]!, edge = graph[parent.from]![parent.edge]!
      edge.capacity -= amount
      graph[node]![edge.reverse]!.capacity += amount
      node = parent.from
    }
    covered += amount
  }
  return true
}

/**
 * Customer consent is needed unless, at every point in time, the new version asks for no more
 * money than the current one. Proven deferrals and reductions only need a notice.
 */
export function consentReasons(current: PlanVersion, next: PlanVersion, obligation: Obligation) {
  const before = dueEntries(current, obligation), after = dueEntries(next, obligation)
  const cumulative = (entries: DueEntry[], key: DueKey) => entries.filter((entry) => noLater(entry.key, key)).reduce((total, entry) => total + entry.amount, 0n)
  const reasons: string[] = []
  for (const key of [...before, ...after].map((entry) => entry.key)) {
    const was = cumulative(before, key), now = cumulative(after, key)
    if (now > was) reasons.push(`Asks for ${formatMinor(now - was, obligation.currency)} ${obligation.currency} more by ${describeKey(key)}`)
  }
  if (!reasons.length && !coveredByEarlierMoney(before, after))
    reasons.push("Cannot prove that combined payments ask for no more money at every point in time")
  return [...new Set(reasons)]
}

/** The paid part of a collection plan, as the dated pieces the payments settled in due order. */
export function settledPieces(plan: PlanVersion, paidMinor: string) {
  if (plan.arrangement.kind !== "collection_installments") return []
  let paid = BigInt(paidMinor)
  return plan.arrangement.installments.flatMap((item) => {
    const piece = paid < BigInt(item.grossMinor) ? paid : BigInt(item.grossMinor)
    paid -= piece
    return piece > 0n ? [{ dueDate: item.dueDate, grossMinor: piece.toString() }] : []
  })
}

export type AmendmentImpact = {
  refusals: PlanRefusal[]
  /** Issued invoices stay exactly as issued. */
  issuedUnchanged: string[]
  /** Drafts built from a step that changed or disappeared; release and rebuild them from the new version. */
  draftsToRegenerate: Array<{ invoiceId: string; targetId: string; reason: "changed" | "removed" }>
  /** Unsent reminders for changed or removed targets. */
  remindersToReschedule: string[]
  /** Added, removed or changed targets. Public payment links for these must be re-resolved. */
  changedTargets: string[]
  /** Collection plans: settled pieces the new version must start with, unchanged. */
  lockedInstallments: Array<{ dueDate: string; grossMinor: string }>
  consent: { required: boolean; reasons: string[] }
  notifyCustomer: boolean
  /** A saved-method authority scoped to the current version, if one exists (#51). */
  authority: { renewalRequired: boolean; reasons: string[] } | null
}

/** Pure consequences of replacing `current` with `next`; nothing is changed. */
export function planAmendmentImpact(current: PlanVersion, next: PlanVersion, obligation: Obligation, facts: PlanFacts, authority: CollectionAuthority | null = null): AmendmentImpact {
  const refusals: PlanRefusal[] = []
  const before = new Map(targetsOf(current).map((target) => [target.targetId, target]))
  const after = new Map(targetsOf(next).map((target) => [target.targetId, target]))
  const same = (id: string) => {
    const a = before.get(id), b = after.get(id)
    return !!a && !!b && a.grossMinor === b.grossMinor && a.terms === b.terms
  }
  const changedTargets = [...new Set([...before.keys(), ...after.keys()])].filter((id) => !same(id))

  const issuedUnchanged: string[] = [], draftsToRegenerate: AmendmentImpact["draftsToRegenerate"] = []
  for (const document of facts.documents) {
    if (document.status === "issued") {
      if (!same(document.targetId)) refusals.push(refuse("issued_step_immutable", `Step ${document.targetId} is issued as ${document.invoiceId}; correct it with a credit note, not a plan edit`))
      issuedUnchanged.push(document.invoiceId)
    } else if (!same(document.targetId)) {
      draftsToRegenerate.push({ invoiceId: document.invoiceId, targetId: document.targetId, reason: after.has(document.targetId) ? "changed" : "removed" })
    }
  }
  for (const receipt of facts.advanceReceipts) {
    const kept = after.get(receipt.advanceId)
    if (!kept || kept.grossMinor < BigInt(receipt.grossMinor))
      refusals.push(refuse("received_advance_immutable", `Advance ${receipt.advanceId} already received ${formatMinor(receipt.grossMinor, obligation.currency)}; refund it instead`))
  }
  const lockedInstallments = settledPieces(current, facts.paidMinor)
  if (next.arrangement.kind === "collection_installments") {
    const head = next.arrangement.installments.slice(0, lockedInstallments.length)
    if (head.length !== lockedInstallments.length || head.some((item, index) => item.dueDate !== lockedInstallments[index]!.dueDate || item.grossMinor !== lockedInstallments[index]!.grossMinor))
      refusals.push(refuse("paid_installment_immutable", "The new version must keep every paid installment with its original date and amount"))
  }
  const reasons = consentReasons(current, next, obligation)
  return {
    refusals, issuedUnchanged, draftsToRegenerate, changedTargets, lockedInstallments,
    remindersToReschedule: facts.reminders.filter((reminder) => changedTargets.includes(reminder.targetId)).map((reminder) => reminder.reminderId),
    consent: { required: reasons.length > 0, reasons },
    notifyCustomer: changedTargets.length > 0 || current.arrangement.kind !== next.arrangement.kind,
    authority: authority && authority.status === "active" && authority.scope.kind === "plan" && authority.scope.planId === current.planId
      // Settled pieces lead a valid collection version and are never charged again.
      ? authorityRenewal(authority, dueEntries(next, obligation).slice(next.arrangement.kind === "collection_installments" ? lockedInstallments.length : 0), next.currency)
      : null,
  }
}

/**
 * Whether an authority still covers the charges a new version would make. Even when it does, its
 * scope must be re-pointed at the new version: an authority never follows a plan silently.
 */
export function authorityRenewal(authority: CollectionAuthority, entries: Array<{ key: DueKey; amount: bigint }>, currency: string) {
  const reasons: string[] = []
  if (authority.currency !== currency) reasons.push("Currency changed")
  if (entries.some((entry) => entry.amount > BigInt(authority.maxChargeMinor))) reasons.push("A charge exceeds the authorized maximum")
  if (entries.some((entry) => entry.key.kind !== "date")) reasons.push("A charge depends on an event, not a date the payer agreed to")
  const dates = entries.flatMap((entry) => entry.key.kind === "date" && entry.amount > 0n ? [parseCalendarDate(entry.key.date).getTime()] : []).sort((a, b) => a - b)
  if (dates.some((time, index) => index > 0 && (time - dates[index - 1]!) / 86_400_000 < authority.minDaysBetweenCharges)) reasons.push("Charges are closer together than authorized")
  return { renewalRequired: reasons.length > 0, reasons }
}
