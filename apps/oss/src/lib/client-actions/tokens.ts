import { createHmac, timingSafeEqual } from "node:crypto"
import { buildAbsoluteUrl, resolveAppOrigin } from "@quits/shared/http"
import { readFallbackSecret, readProductEnv } from "@quits/shared/runtimeEnv"

/**
 * A client action link is `<linkId>.<signature>`. It names a database row, so the row decides
 * whether the link works: revoking, expiring or narrowing it needs no new secret and affects every
 * copy at once. The signature only keeps the link unguessable; knowing a link id is not enough.
 */

export function getClientActionSecret() {
  const secret = readFallbackSecret(
    readProductEnv(process.env, "PUBLIC_CLIENT_ACTION_SECRET"),
    process.env.BETTER_AUTH_SECRET,
  )
  if (!secret)
    throw new Error("QUITS_PUBLIC_CLIENT_ACTION_SECRET or BETTER_AUTH_SECRET must be configured")
  return secret
}

/** Separate purposes never share a signature, even when they share a secret. */
function sign(purpose: string, value: string, secret: string) {
  return createHmac("sha256", secret).update(`${purpose}:${value}`).digest("base64url")
}

function equal(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function mintClientActionToken(linkId: string, secret = getClientActionSecret()) {
  return `${linkId}.${sign("client-action-link", linkId, secret)}`
}

/** The link id of a genuine token, or null. Says nothing about whether the link still works. */
export function verifyClientActionToken(token: string, secret = getClientActionSecret()) {
  const parts = token.split(".")
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0].length > 100) return null
  return equal(parts[1], sign("client-action-link", parts[0], secret)) ? parts[0] : null
}

export function clientActionUrl(token: string) {
  return buildAbsoluteUrl(
    resolveAppOrigin([readProductEnv(process.env, "APP_ORIGIN"), process.env.BETTER_AUTH_URL], ""),
    `/c/${encodeURIComponent(token)}`,
  )
}

/** The page address of a link row: always the same address for the same link. */
export function clientActionLinkUrl(linkId: string) {
  return clientActionUrl(mintClientActionToken(linkId))
}

export function hashVerificationCode(linkId: string, code: string, secret = getClientActionSecret()) {
  return sign("client-action-code", `${linkId}:${code}`, secret)
}

export function codesMatch(expectedHash: string, linkId: string, code: string, secret = getClientActionSecret()) {
  return equal(expectedHash, hashVerificationCode(linkId, code, secret))
}

/** A cookie value proving the recipient verified their email for this link until `until`. */
export function mintVerifiedSession(linkId: string, until: Date, secret = getClientActionSecret()) {
  const body = `${linkId}.${until.getTime()}`
  return `${body}.${sign("client-action-session", body, secret)}`
}

export function readVerifiedSession(
  value: string | undefined,
  linkId: string,
  now: Date,
  secret = getClientActionSecret(),
) {
  if (!value) return false
  const parts = value.split(".")
  if (parts.length !== 3 || parts[0] !== linkId) return false
  const until = Number(parts[1])
  if (!Number.isFinite(until) || now.getTime() >= until) return false
  return equal(parts[2]!, sign("client-action-session", `${parts[0]}.${parts[1]}`, secret))
}

/** The cookie name carries a digest of the link so several links in one browser do not collide. */
export function verifiedSessionCookieName(linkId: string) {
  return `qca_${createHmac("sha256", "client-action-cookie").update(linkId).digest("hex").slice(0, 16)}`
}
