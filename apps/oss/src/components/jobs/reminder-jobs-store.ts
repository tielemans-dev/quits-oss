import { getRequestOrganizationId } from "../../lib/active-organization"
import { notifyMutation } from "../../lib/query-refresh"
import { useSyncExternalStore } from "react"

import { trpc } from "../../trpc/client"
import { trackerView, type TrackerJob } from "../../lib/jobs/reminder-tracker"

/**
 * Reminder jobs as the server reports them, shared by the invoice pills and the tracker toast.
 * Nothing here is progress of its own: it only reads `jobs.list`, and polls while a job runs.
 */
const POLL_MS = 1500
const listeners = new Set<() => void>()
let jobs: TrackerJob[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let queueing = 0

function emit() {
  for (const listener of listeners) listener()
}

let inflight: Promise<void> | undefined

/** One read at a time, so overlapping callers never start a second polling chain. */
export function refreshReminderJobs() {
  inflight ??= read().finally(() => {
    inflight = undefined
  })
  return inflight
}

async function read() {
  clearTimeout(timer)
  try {
    const previous = new Map(jobs.map(job => [job.id, trackerView(job).phase]))
    jobs = (await trpc.jobs.list.query()) as TrackerJob[]
    if (jobs.some(job => previous.has(job.id) && previous.get(job.id) !== trackerView(job).phase && trackerView(job).phase !== "running")) notifyMutation("jobs.settled", getRequestOrganizationId())
    emit()
  } catch {
    // The next poll or visit tries again; the toast keeps what it last knew.
  }
  const active = queueing > 0 || jobs.some((job) => trackerView(job).phase === "running")
  if (active) timer = setTimeout(() => listeners.size && void refreshReminderJobs(), POLL_MS)
}

/**
 * The job is held for the undo window and then runs; it is read while it waits and while it runs.
 * A caller that may try again passes the same `clientRequestId`, and the server queues the job once.
 */
export async function sendReminderBatch(invoiceIds: string[], clientRequestId: string = crypto.randomUUID()) {
  queueing += 1
  const queued = trpc.jobs.sendReminders.mutate({ invoiceIds, clientRequestId })
  void refreshReminderJobs()
  try {
    return await queued
  } finally {
    queueing -= 1
    await refreshReminderJobs()
  }
}

export async function retryReminderStep(jobId: string, stepId: string) {
  await trpc.jobs.retryStep.mutate({ jobId, stepId })
  await refreshReminderJobs()
}

export async function exportVat(from: string, clientRequestId: string) {
  queueing += 1
  const queued = trpc.jobs.exportVat.mutate({ from, clientRequestId })
  void refreshReminderJobs()
  try { return await queued }
  finally { queueing -= 1; await refreshReminderJobs() }
}

/** Stable, so React does not resubscribe on every render and cut the polling chain between two reads. */
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) void refreshReminderJobs()
  return () => void listeners.delete(listener)
}

export function useReminderJobs() {
  return useSyncExternalStore(subscribe, () => jobs, () => [])
}
