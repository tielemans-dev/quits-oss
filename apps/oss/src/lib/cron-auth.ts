/** Checks the shared `CRON_SECRET` bearer token used by scheduler endpoints. */
export function authorizeCronRequest(request: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return new Response("Server misconfigured: CRON_SECRET is required", { status: 503 })
  }

  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  return null
}
