import { APIError } from "better-auth/api"
import { getRequestIP } from "@tanstack/react-start/server"
import ipaddr from "ipaddr.js"
import type { PrismaClient } from "../../../generated/prisma/client"

function address(value: string) {
  try {
    if (value.includes("%") || (!value.includes(":") && !ipaddr.IPv4.isValidFourPartDecimal(value))) return null
    const parsed = ipaddr.parse(value)
    return parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed
  } catch { return null }
}

function trustedNetworks(setting: string) {
  return setting.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [literal, mask, extra] = entry.split("/")
    const parsed = address(literal!)
    const bits = mask === undefined ? (parsed?.kind() === "ipv4" ? 32 : 128) : Number(mask)
    if (!parsed || extra !== undefined || (mask !== undefined && !/^\d+$/.test(mask)) || !Number.isInteger(bits) || bits < 0 || bits > (parsed.kind() === "ipv4" ? 32 : 128)) {
      throw new Error("QUITS_AUTH_TRUSTED_PROXIES must contain literal IP addresses or valid CIDR ranges")
    }
    return { bytes: parsed.toByteArray(), bits }
  })
}

/** Only a trusted direct peer can supply a forwarded chain. The first untrusted hop is the client. */
export function resolveRecoveryClientKey(peer: string | undefined, request?: Request, trustedProxies = ""): string {
  const parsedPeer = peer ? address(peer) : null
  if (!parsedPeer) return "unknown-peer"
  const networks = trustedNetworks(trustedProxies)
  function trusted(parsed: NonNullable<ReturnType<typeof address>>) {
    const bytes = parsed.toByteArray()
    return networks.some((network) => {
      if (bytes.length !== network.bytes.length) return false
      for (let bit = 0; bit < network.bits; bit++) {
        const mask = 1 << (7 - bit % 8)
        if ((bytes[Math.floor(bit / 8)]! & mask) !== (network.bytes[Math.floor(bit / 8)]! & mask)) return false
      }
      return true
    })
  }
  const direct = parsedPeer.toString()
  if (!trusted(parsedPeer)) return direct
  const forwarded = request?.headers.get("x-forwarded-for")
  if (!forwarded || forwarded.length > 4096) return direct
  const hops = forwarded.split(",")
  if (hops.length > 64) return direct
  for (let index = hops.length - 1; index >= 0; index--) {
    const hop = address(hops[index]!.trim())
    if (!hop) return direct
    if (!trusted(hop)) return hop.toString()
  }
  // A chain consisting only of proxies has no independently identified client.
  return direct
}

/** A missing direct peer uses one conservative bucket. Stock proxy deployments configure an allowlist. */
export function recoveryClientKey(request?: Request, trustedProxies?: string): string {
  let peer: string | undefined
  try {
    peer = getRequestIP({ xForwardedFor: false })
  } catch { /* No active server request context. */ }
  return resolveRecoveryClientKey(peer, request, trustedProxies)
}

export async function admitRecoveryRequest(prisma: PrismaClient, path: string, clientKey: string, secret?: string) {
  // Do not store addresses or header values. A configured auth secret prevents dictionary lookup
  // of low-entropy peer addresses from a leaked counter table.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret ?? ""}\0${path}\0${clientKey}`))
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  const max = path === "/request-password-reset" ? 3 : 5
  // Prisma stores resetAt as UTC timestamp without time zone. Match that type for every
  // write and comparison, including cleanup, independently of connection timezone or DST.
  // Bound cleanup, and recheck expiry on DELETE so a refreshed bucket cannot be deleted by a stale selection.
  await prisma.$executeRaw`
    DELETE FROM auth_recovery_rate_limit
    WHERE key IN (SELECT key FROM auth_recovery_rate_limit WHERE "resetAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 hour' LIMIT 100)
      AND "resetAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 hour'
  `
  const admitted = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO auth_recovery_rate_limit (key, count, "resetAt") VALUES (${key}, 1, (NOW() AT TIME ZONE 'UTC') + INTERVAL '60 seconds')
    ON CONFLICT (key) DO UPDATE
      SET count = CASE WHEN auth_recovery_rate_limit."resetAt" <= (NOW() AT TIME ZONE 'UTC') THEN 1 ELSE auth_recovery_rate_limit.count + 1 END,
          "resetAt" = CASE WHEN auth_recovery_rate_limit."resetAt" <= (NOW() AT TIME ZONE 'UTC') THEN (NOW() AT TIME ZONE 'UTC') + INTERVAL '60 seconds' ELSE auth_recovery_rate_limit."resetAt" END
      WHERE auth_recovery_rate_limit."resetAt" <= (NOW() AT TIME ZONE 'UTC') OR auth_recovery_rate_limit.count < ${max}
    RETURNING count
  `
  if (admitted.length === 0) {
    throw new APIError("TOO_MANY_REQUESTS", { message: "Too many requests. Please try again later." }, { "Retry-After": "60" })
  }
}
