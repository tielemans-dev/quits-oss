import { createHmac, timingSafeEqual } from "node:crypto"
import type { z } from "zod"
import {
  quotePublicTokenPayloadSchema,
  type QuotePublicDecision,
  type QuotePublicDecisionState,
  type QuotePublicSnapshot,
  type QuotePublicTokenPayload,
} from "@quits/contracts/quotes"

export type {
  QuotePublicDecision,
  QuotePublicDecisionState,
  QuotePublicSnapshot,
  QuotePublicTokenPayload,
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url")
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8")
}

function signValue(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url")
}

export function getQuotePublicDecisionState(
  snapshot: Pick<QuotePublicSnapshot, "status" | "publicDecisionAt">
): QuotePublicDecisionState {
  if (snapshot.status === "accepted") {
    return "accepted"
  }

  if (snapshot.status === "rejected") {
    return "rejected"
  }

  return "pending"
}

export function applyPublicQuoteDecision(
  snapshot: QuotePublicSnapshot,
  input: {
    decision: QuotePublicDecision
    decidedAt: Date
    rejectionReason?: string
  }
) {
  if (getQuotePublicDecisionState(snapshot) !== "pending") {
    throw new Error("Quote already has a customer decision")
  }

  return {
    ...snapshot,
    status: input.decision,
    publicDecisionAt: input.decidedAt,
    publicRejectionReason:
      input.decision === "rejected" ? input.rejectionReason?.trim() || null : null,
  }
}

export function assertQuoteCommercialFieldsMutable(
  snapshot: Pick<QuotePublicSnapshot, "status">
) {
  if (snapshot.status === "accepted") {
    throw new Error("Accepted quotes are locked")
  }
}

export function signQuotePublicToken(
  payload: z.input<typeof quotePublicTokenPayloadSchema>,
  secret: string
) {
  const encodedPayload = base64UrlEncode(
    JSON.stringify(quotePublicTokenPayloadSchema.parse(payload))
  )
  const signature = signValue(encodedPayload, secret)
  return `${encodedPayload}.${signature}`
}

export function verifyQuotePublicToken(
  token: string,
  secret: string
): QuotePublicTokenPayload | null {
  const [encodedPayload, signature] = token.split(".")
  if (!encodedPayload || !signature) {
    return null
  }

  const expectedSignature = signValue(encodedPayload, secret)
  const actual = Buffer.from(signature, "utf8")
  const expected = Buffer.from(expectedSignature, "utf8")

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null
  }

  try {
    const parsed = quotePublicTokenPayloadSchema.safeParse(
      JSON.parse(base64UrlDecode(encodedPayload)) as unknown
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
