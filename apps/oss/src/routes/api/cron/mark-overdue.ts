import { createFileRoute } from "@tanstack/react-router"
import { authorizeCronRequest } from "../../../lib/cron-auth"

/** Legacy alias kept for existing schedulers; `/api/cron/tick` runs this and everything else. */
async function handleMarkOverdue(request: Request) {
  const denied = authorizeCronRequest(request)
  if (denied) {
    return denied
  }

  const { runOverdueTask } = await import("../../../domain/features/overdue")
  const result = await runOverdueTask()
  return Response.json({ ok: true, marked: result.marked })
}

export const Route = createFileRoute("/api/cron/mark-overdue")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleMarkOverdue(request),
    },
  },
})
