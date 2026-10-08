import { createFileRoute } from "@tanstack/react-router"
import { guardCronRequest } from "./-guard"

/** Legacy alias kept for existing schedulers; `/api/cron/tick` runs this and everything else. */
async function handleMarkOverdue(request: Request) {
  const denied = guardCronRequest(request)
  if (denied) {
    return denied
  }

  const { isOperationsHeld } = await import("../../../lib/operations-hold")
  if (await isOperationsHeld()) {
    return Response.json({ ok: true, held: true, marked: 0, failed: 0, remaining: 0 })
  }
  const { runOverdueTask } = await import("../../../domain/features/overdue")
  const result = await runOverdueTask()
  const ok = result.failed === 0
  return Response.json(
    { ok, marked: result.marked, failed: result.failed, remaining: result.remaining },
    { status: ok ? 200 : 500 }
  )
}

export const Route = createFileRoute("/api/cron/mark-overdue")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleMarkOverdue(request),
    },
  },
})
