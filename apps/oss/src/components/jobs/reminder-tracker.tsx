import { Check, Loader2, X } from "lucide-react"
import { useEffect, useState } from "react"

import { useI18n } from "../../lib/i18n/react"
import type { TranslationKey } from "../../lib/i18n/messages"
import { pickTrackedJob, TRACKER_TITLE, trackerView, type StepState, type TrackerJob } from "../../lib/jobs/reminder-tracker"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { retryReminderStep, useReminderJobs } from "./reminder-jobs-store"
import { useTrackerHeld } from "./tracker-hold"
import { trpc } from "../../trpc/client"
import { downloadTextFile } from "../../lib/exports/download"

const STEP_LABEL = {
  waiting: "reminders.tracker.step.waiting",
  sending: "reminders.tracker.step.sending",
  sent: "reminders.tracker.step.sent",
  failed: "reminders.tracker.step.failed",
} as const satisfies Record<StepState, TranslationKey>

const DONE_LINGER_MS = 8000 // a failed toast stays until retried or closed
const FRESH_MS = 10_000 // a younger job was started on this page: its toast morphs in
const ease = "ease-enter"
const swap = `transition-[opacity,transform,filter] duration-(--duration-base) ${ease} motion-reduce:transition-opacity motion-reduce:duration-(--duration-fade)`
const hidden = "scale-25 opacity-0 blur-[4px] motion-reduce:scale-100 motion-reduce:blur-none"

function Mark({ on, children, className }: { on: boolean; children: React.ReactNode; className?: string }) {
  return (
    <span aria-hidden className={cn("absolute inset-0 grid place-items-center", swap, !on && hidden, className)}>
      {children}
    </span>
  )
}

/**
 * The corner toast of a reminder job. It shows what the server says (`trackerView`) and owns no
 * progress. `fresh` plays the morph out of the spinner square; reduced motion fades instead.
 */
export function TrackerToast({
  job,
  fresh,
  onRetry,
  onDismiss,
}: {
  job: TrackerJob
  fresh?: boolean
  onRetry: (stepId: string) => void
  onDismiss: () => void
}) {
  const { t } = useI18n()
  const view = trackerView(job)
  const vat = job.kind === "vat.summary"
  const [downloadError, setDownloadError] = useState(false)
  async function download() {
    try {
      const file = await trpc.jobs.vatDownload.query({ jobId: job.id })
      downloadTextFile(file.filename, file.csv, "text/csv;charset=utf-8")
      setDownloadError(false)
    } catch { setDownloadError(true) }
  }
  const counter = t("reminders.tracker.counter", { sent: view.sent, total: view.total })

  return (
    <section
      data-slot="reminder-tracker"
      data-job-id={job.id}
      data-phase={view.phase}
      aria-label={t(vat ? "shell.request.title.vat" : "reminders.tracker.label")}
      className="fixed right-4 bottom-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)] [filter:drop-shadow(0_8px_24px_rgb(11_11_12/0.18))]"
    >
      <div className={cn("bg-popover text-popover-foreground border-hairline relative min-h-44 rounded-2xl border p-4", fresh && "tracker-morph")}>
        {fresh ? (
          <span aria-hidden className="tracker-spinner pointer-events-none absolute right-0 bottom-0 grid size-44 place-items-center">
            <Loader2 className="text-muted-foreground size-6 animate-spin" />
          </span>
        ) : null}
        <div className="flex items-start justify-between gap-3">
          <h2 aria-live="polite" className="text-sm font-semibold">
            {t(vat ? `shell.request.vat.${view.phase}` : TRACKER_TITLE[view.phase])}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("reminders.tracker.dismiss")}
            className="-mt-1 -mr-1 transition-[color,background-color]"
            onClick={onDismiss}
          >
            <X />
          </Button>
        </div>
        <ul className="mt-3 space-y-2">
          {view.steps.map((step) => (
            <li key={step.id} data-state={step.state} className="flex items-center gap-2 text-xs">
              <span className="relative size-4 shrink-0">
                <Mark on={step.state === "sent"} className="text-tone-success">
                  <Check className="size-3.5" />
                </Mark>
                <Mark on={step.state === "sending"}>
                  <Loader2 className="text-muted-foreground size-3.5 motion-safe:animate-spin" />
                </Mark>
                <Mark on={step.state === "failed"} className="text-tone-danger">
                  <X className="size-3.5" />
                </Mark>
              </span>
              <span className="min-w-0 flex-1 truncate">
                {t(step.label as TranslationKey, step.labelParams as Record<string, string>)}
              </span>
              <span className={cn("text-muted-foreground", step.state === "failed" && "text-tone-danger")}>
                {t(vat && step.state === "sent" ? "shell.request.vat.done" : vat && step.state === "sending" ? "shell.request.vat.running" : STEP_LABEL[step.state])}
              </span>
              {step.state === "failed" && !vat ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={view.phase === "running"} // the server refuses a retry while the job runs
                  className="transition-[color,background-color,box-shadow]"
                  onClick={() => onRetry(step.id)}
                >
                  {t("reminders.tracker.retry")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-1.5">
          <p className="text-muted-foreground text-xs tabular-nums">{counter}</p>
          <div
            role="progressbar"
            aria-label={counter}
            aria-valuemin={0}
            aria-valuemax={view.total}
            aria-valuenow={view.sent}
            className="bg-foreground/10 h-1 overflow-hidden rounded-full"
          >
            <div
              className={cn("bg-tone-progress h-full rounded-full transition-[transform] duration-(--duration-base) motion-reduce:transition-none", ease)}
              style={{ transform: `translateX(${view.percent - 100}%)` }}
            />
          </div>
        </div>
        {vat && view.phase === "done" && <Button type="button" variant="outline" size="sm" onClick={() => void download()} className="mt-3 transition-[color,background-color,box-shadow]">{t("shell.request.vat.download")}</Button>}
        {downloadError && <p role="alert" className="text-destructive mt-2 text-sm">{t("shell.request.vat.error")}</p>}
        {vat && view.phase === "failed" && <p className="text-muted-foreground mt-2 text-sm">{t("shell.request.vat.retry")}</p>}
      </div>
    </section>
  )
}

const DISMISSED_KEY = "quits.tracker.dismissed"

/** Closed toasts stay closed across reloads; only the latest few are worth remembering. */
function readDismissed(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]")
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [])
  } catch {
    return new Set()
  }
}

function storeDismissed(ids: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-50)))
  } catch {
    // Without storage a closed toast is closed until the next reload.
  }
}

/** Mounted once in the app layout: follows the newest reminder job the server reports. */
export function ReminderTracker() {
  const jobs = useReminderJobs()
  const held = useTrackerHeld()
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set())
  const [dismissed, setDismissed] = useState(readDismissed)
  const job = pickTrackedJob(jobs, seen, dismissed)
  const phase = job ? trackerView(job).phase : undefined
  const id = job?.id
  const dismiss = (jobId: string) => setDismissed((current) => {
    const next = new Set(current).add(jobId)
    storeDismissed(next)
    return next
  })

  useEffect(() => {
    if (id && phase === "running") setSeen((current) => (current.has(id) ? current : new Set(current).add(id)))
  }, [id, phase])

  useEffect(() => {
    if (!id || phase !== "done" || job?.kind === "vat.summary") return
    const timer = setTimeout(() => dismiss(id), DONE_LINGER_MS)
    return () => clearTimeout(timer)
  }, [id, phase, job?.kind])

  if (!job || held) return null
  return (
    <TrackerToast
      key={job.id}
      job={job}
      fresh={Date.now() - new Date(job.createdAt).getTime() < FRESH_MS}
      onRetry={(stepId) => void retryReminderStep(job.id, stepId).catch(() => {})}
      onDismiss={() => dismiss(job.id)}
    />
  )
}
