import { addUtcDays, advanceRunDate, anchorDayOf, firstRunDateFrom, formatCalendarDate, parseCalendarDate } from "../features/recurring-dates"
import { authorityRenewal } from "./amendment"
import { formatMinor } from "./amounts"
import { refuse, type CollectionAuthority, type PlanRefusal, type RecurringInstruction } from "./model"

export type RunPreview = { runDate: string; version: number; periodGrossMinor: string; dueDate: string }

/**
 * The next runs one instruction version would generate on or after `from`, using the recurrence
 * executor's own date functions so a preview and a run cannot disagree. `after_runs` counts runs
 * from the version's effective date.
 */
export function previewRuns(instruction: RecurringInstruction, from: string, count: number): RunPreview[] {
  const cadence = { startDate: parseCalendarDate(instruction.anchorDate), intervalCount: instruction.intervalCount, intervalUnit: instruction.intervalUnit }
  const anchor = anchorDayOf(cadence.startDate)
  const effective = firstRunDateFrom(cadence, parseCalendarDate(instruction.effectiveFrom))
  const ends = instruction.end.type === "on_date" ? parseCalendarDate(instruction.end.endsAt) : null
  const limit = instruction.end.type === "after_runs" ? instruction.end.runs : Number.POSITIVE_INFINITY
  const runs: RunPreview[] = []
  let run = effective
  for (let index = 0; index < limit && runs.length < count && index < 10_000; index += 1, run = advanceRunDate(run, cadence.intervalCount, cadence.intervalUnit, anchor)) {
    if (ends && run > ends) break
    if (formatCalendarDate(run) < from) continue
    runs.push({ runDate: formatCalendarDate(run), version: instruction.version, periodGrossMinor: instruction.periodGrossMinor, dueDate: formatCalendarDate(addUtcDays(run, instruction.dueInDays)) })
  }
  return runs
}

const intervalDays = (instruction: RecurringInstruction) =>
  instruction.intervalCount * { week: 7, month: 365.25 / 12, year: 365.25 }[instruction.intervalUnit]

/**
 * Check every interval in the term, independently of the display preview. Gregorian month/year
 * dates and their clamping repeat every 400 years. Once a run's year modulo 400, month and day
 * repeat, every later interval repeats too. Weekly intervals are constant. This is a complete
 * calendar cycle, not a sampled horizon; finite date/count limits stop it earlier.
 */
function recurringAuthorityRenewal(authority: CollectionAuthority, instruction: RecurringInstruction) {
  const first = previewRuns(instruction, instruction.effectiveFrom, 1)[0]
  const renewal = authorityRenewal(authority, first
    ? [{ key: { kind: "date", date: first.runDate }, amount: BigInt(first.periodGrossMinor) }]
    : [], instruction.currency)
  if (!first || authority.minDaysBetweenCharges === 0) return renewal

  const anchor = anchorDayOf(parseCalendarDate(instruction.anchorDate))
  const ends = instruction.end.type === "on_date" ? parseCalendarDate(instruction.end.endsAt) : null
  const phases = new Set<string>()
  let run = parseCalendarDate(first.runDate), runCount = 1
  while (instruction.end.type !== "after_runs" || runCount < instruction.end.runs) {
    const phase = `${run.getUTCFullYear() % 400}:${run.getUTCMonth()}:${run.getUTCDate()}`
    if (phases.has(phase)) break
    phases.add(phase)
    const successor = advanceRunDate(run, instruction.intervalCount, instruction.intervalUnit, anchor)
    if (ends && successor > ends) break
    if ((successor.getTime() - run.getTime()) / 86_400_000 < authority.minDaysBetweenCharges) {
      renewal.renewalRequired = true
      renewal.reasons.push("Charges are closer together than authorized")
      break
    }
    if (instruction.intervalUnit === "week") break
    run = successor
    runCount += 1
  }
  return renewal
}

/** Consent is independent of the UI preview length. Unprovable end-kind changes are conservative. */
function termConsentReason(current: RecurringInstruction, next: RecurringInstruction): string | null {
  const firstAfter = previewRuns(next, next.effectiveFrom, 1)[0]
  if (!firstAfter) return null
  const firstBefore = previewRuns(current, next.effectiveFrom, 1)[0]
  if (!firstBefore) return "Restarts an instruction with no remaining authorized runs"
  if (current.end.type === "none") return null
  if (next.end.type === "none") return "Removes the agreed end condition"
  if (current.end.type !== next.end.type) return "Changes the kind of end condition; consent is required to replace the agreed limit"
  if (current.end.type === "on_date" && next.end.type === "on_date" && next.end.endsAt > current.end.endsAt)
    return "Extends the agreed end date"
  if (current.end.type === "after_runs" && next.end.type === "after_runs") {
    // Counts belong to each version's effective date, not the lifetime instruction. Keeping the
    // same count on a later version can therefore add runs. Compare all remaining authorized runs.
    const remaining = previewRuns(current, next.effectiveFrom, current.end.runs).length
    if (next.end.runs > remaining) return "Adds runs beyond the remaining agreed count"
  }
  return null
}

export type RecurringImpact = {
  refusals: PlanRefusal[]
  /** Runs generated before the effective date keep the version they were generated under. */
  unchangedRuns: string[]
  /** Unsent drafts generated for a run this version now governs; rebuild them. */
  draftsToRegenerate: Array<{ invoiceId: string; runDate: string }>
  futureRuns: Array<{ before: RunPreview | null; after: RunPreview | null; changed: boolean }>
  consent: { required: boolean; reasons: string[] }
  /** Turning on auto-send emails customers unattended; the existing agent approval rule applies. */
  requiresHumanActivation: boolean
  authority: { renewalRequired: boolean; reasons: string[] } | null
}

/**
 * Consequences of a new instruction version from its effective date. Generation, sending and
 * collection stay separate: nothing here charges a customer, and a saved-method collection can
 * never be switched on by an amendment.
 */
export function recurringAmendmentImpact(current: RecurringInstruction, next: RecurringInstruction, facts: {
  today: string
  generatedRuns: Array<{ runDate: string; invoiceId: string; status: "draft" | "issued" }>
  previewCount?: number
}, authority: CollectionAuthority | null = null): RecurringImpact {
  const refusals: PlanRefusal[] = []
  if (next.recurringInvoiceId !== current.recurringInvoiceId || next.version !== current.version + 1)
    refusals.push(refuse("version_sequence", `Expected version ${current.version + 1} of ${current.recurringInvoiceId}`))
  if (next.currency !== current.currency) refusals.push(refuse("currency_mismatch", "A different currency is a new schedule"))
  if (next.effectiveFrom < facts.today) refusals.push(refuse("effective_date_in_past", "A change takes effect today at the earliest"))
  const governed = facts.generatedRuns.filter((run) => run.runDate >= next.effectiveFrom)
  for (const run of governed.filter((item) => item.status === "issued"))
    refusals.push(refuse("issued_step_immutable", `The ${run.runDate} run is issued as ${run.invoiceId}; start the change after it`))
  if (current.collection.kind === "manual" && next.collection.kind === "saved_method")
    refusals.push(refuse("arrangement_not_allowed", "Automatic collection needs its own authority and consent, not a schedule edit (#51)"))

  const count = facts.previewCount ?? 3
  const before = previewRuns(current, next.effectiveFrom, count), after = previewRuns(next, next.effectiveFrom, count)
  const futureRuns = Array.from({ length: Math.max(before.length, after.length) }, (_, index) => {
    const a = before[index] ?? null, b = after[index] ?? null
    return { before: a, after: b, changed: !a || !b || a.runDate !== b.runDate || a.periodGrossMinor !== b.periodGrossMinor || a.dueDate !== b.dueDate }
  })

  const firstBefore = previewRuns(current, next.effectiveFrom, 1)[0], firstAfter = previewRuns(next, next.effectiveFrom, 1)[0]
  const reasons: string[] = []
  if (BigInt(next.periodGrossMinor) > BigInt(current.periodGrossMinor))
    reasons.push(`Price rises from ${formatMinor(current.periodGrossMinor, current.currency)} to ${formatMinor(next.periodGrossMinor, next.currency)} ${next.currency} per period`)
  // Equal first dates can hide later advances when month-end clamping wears off.
  // A different anchor or cadence has no proven whole-term dominance here.
  if (intervalDays(next) < intervalDays(current)) reasons.push("Invoices come more often")
  else if (firstAfter && (next.anchorDate !== current.anchorDate || next.intervalUnit !== current.intervalUnit || next.intervalCount !== current.intervalCount))
    reasons.push("Changes the recurrence anchor or cadence; future payment dates need consent")
  if (next.dueInDays < current.dueInDays) reasons.push("Payment terms are shorter")
  if (firstBefore && firstAfter && firstAfter.runDate < firstBefore.runDate) reasons.push(`The next invoice comes earlier, on ${firstAfter.runDate}`)
  const termReason = termConsentReason(current, next)
  if (termReason) reasons.push(termReason)

  const renewal = authority && authority.status === "active" && current.collection.kind === "saved_method" && current.collection.authorityId === authority.authorityId
    ? recurringAuthorityRenewal(authority, next)
    : null
  if (renewal && termReason) {
    renewal.renewalRequired = true
    renewal.reasons.push("The amended term needs authority for additional or changed service obligations")
  }

  return {
    refusals,
    unchangedRuns: facts.generatedRuns.filter((run) => run.runDate < next.effectiveFrom).map((run) => run.invoiceId),
    draftsToRegenerate: governed.filter((run) => run.status === "draft").map((run) => ({ invoiceId: run.invoiceId, runDate: run.runDate })),
    futureRuns,
    consent: { required: reasons.length > 0, reasons },
    requiresHumanActivation: current.delivery === "draft_only" && next.delivery === "auto_send",
    authority: renewal,
  }
}
