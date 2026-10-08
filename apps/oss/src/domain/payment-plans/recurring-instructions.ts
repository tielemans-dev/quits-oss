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

  const reasons: string[] = []
  if (BigInt(next.periodGrossMinor) > BigInt(current.periodGrossMinor))
    reasons.push(`Price rises from ${formatMinor(current.periodGrossMinor, current.currency)} to ${formatMinor(next.periodGrossMinor, next.currency)} ${next.currency} per period`)
  if (intervalDays(next) < intervalDays(current)) reasons.push("Invoices come more often")
  if (next.dueInDays < current.dueInDays) reasons.push("Payment terms are shorter")
  if (before[0] && after[0] && after[0].runDate < before[0].runDate) reasons.push(`The next invoice comes earlier, on ${after[0].runDate}`)

  return {
    refusals,
    unchangedRuns: facts.generatedRuns.filter((run) => run.runDate < next.effectiveFrom).map((run) => run.invoiceId),
    draftsToRegenerate: governed.filter((run) => run.status === "draft").map((run) => ({ invoiceId: run.invoiceId, runDate: run.runDate })),
    futureRuns,
    consent: { required: reasons.length > 0, reasons },
    requiresHumanActivation: current.delivery === "draft_only" && next.delivery === "auto_send",
    authority: authority && authority.status === "active" && current.collection.kind === "saved_method" && current.collection.authorityId === authority.authorityId
      ? authorityRenewal(authority, after.map((run) => ({ key: { kind: "date" as const, date: run.runDate }, amount: BigInt(run.periodGrossMinor) })), next.currency)
      : null,
  }
}
