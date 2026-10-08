import { createFileRoute } from "@tanstack/react-router"
import { guardCronRequest, tickResponse } from "./-guard"

async function handleTick(request: Request) {
  const denied = guardCronRequest(request)
  if (denied) {
    return denied
  }

  await import("../../../domain/scheduler-tasks")
  const { runSchedulerTick } = await import("../../../domain/scheduler")
  const { isOperationsHeld, recordSchedulerTick } = await import("../../../lib/operations-hold")
  if (await isOperationsHeld()) {
    // A held installation (restore awaiting review) skips all scheduled work. That is expected,
    // not a failure, so the scheduler is not alerted; `held` tells monitors why nothing ran.
    await recordSchedulerTick(true)
    return Response.json({ ok: true, held: true, failedTasks: [], retryingTasks: [], results: {} })
  }
  const response = tickResponse(await runSchedulerTick())
  await recordSchedulerTick(response.ok)
  return response
}

/** Runs all scheduled work: overdue marking, reminders, recurring invoices, and queued jobs. */
export const Route = createFileRoute("/api/cron/tick")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleTick(request),
      POST: ({ request }: { request: Request }) => handleTick(request),
    },
  },
})
