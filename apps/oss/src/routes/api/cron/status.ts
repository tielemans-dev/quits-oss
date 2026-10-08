import { createFileRoute } from "@tanstack/react-router"
import { guardCronRequest } from "./-guard"

/**
 * Operational status for monitors: backup age, issued-artifact completeness, scheduler and mail
 * health, and whether operations are held. Authorized like the scheduler, with `CRON_SECRET`.
 * Answers 503 when something needs an operator, so an uptime monitor can alert on it directly.
 */
async function handleStatus(request: Request) {
  const denied = guardCronRequest(request)
  if (denied) {
    return denied
  }

  const { prisma } = await import("../../../lib/db")
  const { getRuntimeEnv } = await import("../../../lib/runtime/platform")
  const { getDocumentArtifactStore } = await import("../../../lib/runtime/services")
  const { collectOperationalStatus, environmentHold } = await import("../../../lib/recovery/status")
  const env = getRuntimeEnv()
  const status = await collectOperationalStatus({
    query: async (sql, params = []) => (await prisma.$queryRawUnsafe(sql, ...params)) as Array<Record<string, unknown>>,
    env,
    artifactStore: getDocumentArtifactStore(),
    environmentHold: environmentHold(env),
  })
  return Response.json(status, { status: status.ok ? 200 : 503 })
}

export const Route = createFileRoute("/api/cron/status")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleStatus(request),
    },
  },
})
