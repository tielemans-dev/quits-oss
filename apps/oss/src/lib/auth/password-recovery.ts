import { APIError } from "better-auth/api"
import { getRequestIP } from "@tanstack/react-start/server"
import type { PrismaClient } from "../../../generated/prisma/client"

/** A missing direct peer address uses one conservative shared bucket. Proxy deployments supply a trusted runtime hook. */
export function recoveryClientKey(): string {
  try {
    return getRequestIP({ xForwardedFor: false }) ?? "unknown-peer"
  } catch {
    return "unknown-peer"
  }
}

export async function admitRecoveryRequest(prisma: PrismaClient, path: string, clientKey: string, secret?: string) {
  // Do not store addresses or header values. A configured auth secret prevents dictionary lookup
  // of low-entropy peer addresses from a leaked counter table.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret ?? ""}\0${path}\0${clientKey}`))
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  const max = path === "/request-password-reset" ? 3 : 5
  // Bound cleanup, and recheck expiry on DELETE so a refreshed bucket cannot be deleted by a stale selection.
  await prisma.$executeRaw`
    DELETE FROM auth_recovery_rate_limit
    WHERE key IN (SELECT key FROM auth_recovery_rate_limit WHERE "resetAt" < NOW() - INTERVAL '1 hour' LIMIT 100)
      AND "resetAt" < NOW() - INTERVAL '1 hour'
  `
  const admitted = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO auth_recovery_rate_limit (key, count, "resetAt") VALUES (${key}, 1, NOW() + INTERVAL '60 seconds')
    ON CONFLICT (key) DO UPDATE
      SET count = CASE WHEN auth_recovery_rate_limit."resetAt" <= NOW() THEN 1 ELSE auth_recovery_rate_limit.count + 1 END,
          "resetAt" = CASE WHEN auth_recovery_rate_limit."resetAt" <= NOW() THEN NOW() + INTERVAL '60 seconds' ELSE auth_recovery_rate_limit."resetAt" END
      WHERE auth_recovery_rate_limit."resetAt" <= NOW() OR auth_recovery_rate_limit.count < ${max}
    RETURNING count
  `
  if (admitted.length === 0) {
    throw new APIError("TOO_MANY_REQUESTS", { message: "Too many requests. Please try again later." }, { "Retry-After": "60" })
  }
}
