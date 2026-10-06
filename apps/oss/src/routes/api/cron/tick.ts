import { createFileRoute } from "@tanstack/react-router"
import { guardCronRequest, tickResponse } from "./-guard"

async function handleTick(request: Request) {
  const denied = guardCronRequest(request)
  if (denied) {
    return denied
  }

  await import("../../../domain/scheduler-tasks")
  const { runSchedulerTick } = await import("../../../domain/scheduler")
  return tickResponse(await runSchedulerTick())
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
