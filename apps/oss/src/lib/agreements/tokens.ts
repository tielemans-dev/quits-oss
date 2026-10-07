import { createHmac, timingSafeEqual } from "node:crypto"
import {
  agreementPublicTokenPayloadSchema,
  type AgreementPublicTokenPayload,
} from "@quits/contracts/agreements"
import { buildAbsoluteUrl, resolveAppOrigin } from "@quits/shared/http"
import { readFallbackSecret, readProductEnv } from "@quits/shared/runtimeEnv"

export function getAgreementPublicSecret() {
  const secret = readFallbackSecret(
    readProductEnv(process.env, "PUBLIC_AGREEMENT_SECRET"),
    process.env.BETTER_AUTH_SECRET,
  )
  if (!secret)
    throw new Error("QUITS_PUBLIC_AGREEMENT_SECRET or BETTER_AUTH_SECRET must be configured")
  return secret
}
export function signAgreementPublicToken(payload: AgreementPublicTokenPayload, secret: string) {
  const encoded = Buffer.from(
    JSON.stringify(agreementPublicTokenPayloadSchema.parse(payload)),
  ).toString("base64url")
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`
}
/** Expiry is checked by the operation, after decision replay under the agreement lock. */
export function verifyAgreementPublicToken(token: string, secret: string) {
  const parts = token.split(".")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  const expected = createHmac("sha256", secret).update(parts[0]).digest("base64url")
  const actual = Buffer.from(parts[1])
  if (actual.length !== expected.length || !timingSafeEqual(actual, Buffer.from(expected)))
    return null
  try {
    const parsed = agreementPublicTokenPayloadSchema.safeParse(
      JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
export function agreementTokenUrl(token: string) {
  return buildAbsoluteUrl(
    resolveAppOrigin([readProductEnv(process.env, "APP_ORIGIN"), process.env.BETTER_AUTH_URL], ""),
    `/a/${encodeURIComponent(token)}`,
  )
}
export function mintAgreementLink(
  agreement: {
    id: string
    publicAccessKeyVersion: number
    offerRevision: number
    expiresAt: Date | null
  },
  scope: "decide" | "read",
  now: Date,
) {
  const exp = scope === "read" ? new Date(now) : agreement.expiresAt
  if (!exp) throw new Error("Agreement has no expiry")
  if (scope === "read") exp.setUTCFullYear(exp.getUTCFullYear() + 2)
  const token = signAgreementPublicToken(
    {
      agreementId: agreement.id,
      keyVersion: agreement.publicAccessKeyVersion,
      scope,
      exp: exp.toISOString(),
      ...(scope === "decide" ? { offerRevision: agreement.offerRevision } : {}),
    } as AgreementPublicTokenPayload,
    getAgreementPublicSecret(),
  )
  return { token, url: agreementTokenUrl(token) }
}

/** Recreating a delivery link uses its delivery instant, so reads do not extend its lifetime. */
export function mintDeliverableSignOffLink(
  agreement: { id: string; publicAccessKeyVersion: number },
  line: { id: string; deliveryRevision: number; deliveredAt: Date | null },
) {
  if (!line.deliveredAt || line.deliveryRevision < 1) throw new Error("Deliverable has not been delivered")
  const token = signAgreementPublicToken({
    agreementId: agreement.id,
    keyVersion: agreement.publicAccessKeyVersion,
    scope: "sign_off",
    deliverableId: line.id,
    deliveryRevision: line.deliveryRevision,
    exp: new Date(line.deliveredAt.getTime() + 90 * 86400_000).toISOString(),
  }, getAgreementPublicSecret())
  return { token, url: agreementTokenUrl(token) }
}
