import { createFileRoute } from "@tanstack/react-router"
import { authorizeCronRequest } from "../../../lib/cron-auth"

async function handleTick(request: Request) {
  const denied = authorizeCronRequest(request)
  if (denied) {
    return denied
  }

  await import("../../../domain/scheduler-tasks")
  const { runSchedulerTick } = await import("../../../domain/scheduler")
  return Response.json({ ok: true, results: await runSchedulerTick() })
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
