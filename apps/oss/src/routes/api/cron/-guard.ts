import { authorizeCronRequest } from "../../../lib/cron-auth"

/** Publicly documented placeholder values that must never protect a real deployment. */
const PLACEHOLDER_CRON_SECRETS = new Set(["change-me-in-production"])

/**
 * Authorizes a scheduler request. A missing secret or a known placeholder is a server
 * misconfiguration (503), because anyone could trigger scheduled work with a published value.
 */
export function guardCronRequest(request: Request): Response | null {
  const secret = process.env.CRON_SECRET?.trim()
  if (secret && PLACEHOLDER_CRON_SECRETS.has(secret)) {
    return new Response(
      "Server misconfigured: CRON_SECRET is set to a public placeholder value. " +
        "Set it to a random secret, for example `openssl rand -base64 32`.",
      { status: 503 }
    )
  }
  return authorizeCronRequest(request)
}

type TaskResult = Record<string, number> | { error: string }

/** A task failed when it threw, or when it reports work that failed (`failed > 0`). */
export function taskFailed(result: TaskResult) {
  if ("error" in result) {
    return true
  }
  return typeof result.failed === "number" && result.failed > 0
}

/** `ok: false` with HTTP 500 when any task failed, so schedulers and monitors notice. */
export function tickResponse(results: Record<string, TaskResult>) {
  const failedTasks = Object.entries(results)
    .filter(([, result]) => taskFailed(result))
    .map(([name]) => name)
  return Response.json(
    { ok: failedTasks.length === 0, failedTasks, results },
    { status: failedTasks.length === 0 ? 200 : 500 }
  )
}
