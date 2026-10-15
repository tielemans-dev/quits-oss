import type { TranslationKey } from "../i18n/messages"

/** The part of a `jobs.list` job the tracker reads. The server is the only source of progress. */
export type TrackerJob = {
  id: string
  kind?: string
  status: string
  createdAt: Date | string
  /** Time left in the undo window; nothing has been sent while it is above zero. */
  heldForMs?: number
  steps: {
    id: string
    label: string
    labelParams: unknown
    invoiceId: string | null
    status: string
  }[]
}

/** `waiting` has not started; `sending` is in flight; `failed` is also a step a failed job never ran. */
export type StepState = "waiting" | "sending" | "sent" | "failed"
export type TrackerPhase = "running" | "done" | "failed"

export const TRACKER_TITLE = {
  running: "reminders.tracker.title.running",
  done: "reminders.tracker.title.done",
  failed: "reminders.tracker.title.failed",
} as const satisfies Record<TrackerPhase, TranslationKey>

function stepState(status: string, jobFailed: boolean): StepState {
  if (status === "succeeded") return "sent"
  if (status === "failed" || jobFailed) return "failed"
  return status === "running" ? "sending" : "waiting"
}

/**
 * What the toast shows for a job. Counter, bar and pills all count steps the server says
 * succeeded, so they cannot disagree. A failed step is not progress, and a failed job's unfinished
 * steps read as failed, since nothing will run them until they are retried.
 */
export function trackerView(job: TrackerJob) {
  const jobFailed = job.status === "failed"
  const steps = job.steps.map((step) => ({ ...step, state: stepState(step.status, jobFailed) }))
  const sent = steps.filter((step) => step.state === "sent").length
  const settled = steps.every((step) => step.state === "sent" || step.state === "failed")
  const phase: TrackerPhase = !settled ? "running" : sent === steps.length ? "done" : "failed"
  return { steps, sent, total: steps.length, percent: steps.length ? (sent / steps.length) * 100 : 0, phase }
}

/** Invoices whose reminder step succeeded: the only ones whose pill changes. */
export function remindedInvoiceIds(jobs: readonly TrackerJob[]): Set<string> {
  return new Set(
    jobs.flatMap((job) =>
      job.steps.flatMap((step) => (step.status === "succeeded" && step.invoiceId ? [step.invoiceId] : []))
    )
  )
}

const RECENT_FAILURE_MS = 24 * 60 * 60 * 1000

/**
 * The one job the toast shows: the newest that is running, was running in this tab and has not
 * been dismissed, or failed recently enough to still be worth a retry after a reload.
 */
export function pickTrackedJob(
  jobs: readonly TrackerJob[],
  seen: ReadonlySet<string>,
  dismissed: ReadonlySet<string>,
  now = Date.now()
) {
  return jobs.find((job) => {
    if (dismissed.has(job.id) || job.heldForMs) return false
    const { phase } = trackerView(job)
    if (phase === "running" || seen.has(job.id)) return true
    if (job.kind === "vat.summary" && phase === "done" && now - new Date(job.createdAt).getTime() < RECENT_FAILURE_MS) return true
    return phase === "failed" && now - new Date(job.createdAt).getTime() < RECENT_FAILURE_MS
  })
}
