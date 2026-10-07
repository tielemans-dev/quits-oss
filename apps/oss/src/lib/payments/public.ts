import { createHmac, timingSafeEqual } from "node:crypto"
import type { z } from "zod"
import {
  invoicePaymentTokenPayloadSchema,
  type InvoicePaymentState,
  type InvoicePaymentTokenPayload,
} from "@quits/contracts/payments"
import {
  buildAbsoluteUrl,
  resolveAppOrigin,
} from "@quits/shared/http"
import { readFallbackSecret, readProductEnv } from "@quits/shared/runtimeEnv"

export type { InvoicePaymentState, InvoicePaymentTokenPayload }

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url")
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8")
}

function signValue(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url")
}

/**
 * Whether the customer still has something to pay. An invoice credited in full is settled too:
 * nothing is owed, so it reads as `paid` and no payment is offered.
 */
export function getInvoicePaymentState(snapshot: {
  status: string
  paymentStatus: string
}): InvoicePaymentState {
  if (snapshot.paymentStatus === "paid" || snapshot.status === "paid" || snapshot.status === "credited") {
    return "paid"
  }

  return "unpaid"
}

export function signInvoicePaymentToken(
  payload: z.input<typeof invoicePaymentTokenPayloadSchema>,
  secret: string
) {
  const encodedPayload = base64UrlEncode(
    JSON.stringify(invoicePaymentTokenPayloadSchema.parse(payload))
  )
  const signature = signValue(encodedPayload, secret)
  return `${encodedPayload}.${signature}`
}

export function verifyInvoicePaymentToken(
  token: string,
  secret: string
): InvoicePaymentTokenPayload | null {
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
    const parsed = invoicePaymentTokenPayloadSchema.safeParse(
      JSON.parse(base64UrlDecode(encodedPayload)) as unknown
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function getPublicInvoicePaymentSecret() {
  const secret = readFallbackSecret(
    readProductEnv(process.env, "PUBLIC_PAYMENT_SECRET"),
    process.env.BETTER_AUTH_SECRET
  )
  if (secret) {
    return secret
  }

  throw new Error("QUITS_PUBLIC_PAYMENT_SECRET or BETTER_AUTH_SECRET must be configured")
}

export function getPublicInvoicePaymentUrl(invoice: {
  id: string
  status: string
  paymentStatus: string
  publicPaymentIssuedAt: Date | null
  publicPaymentKeyVersion: number
}) {
  if (
    !invoice.publicPaymentIssuedAt ||
    getInvoicePaymentState(invoice) === "paid" ||
    (invoice.status !== "sent" && invoice.status !== "overdue" && invoice.status !== "paid")
  ) {
    return null
  }

  const origin = resolveAppOrigin(
    [readProductEnv(process.env, "APP_ORIGIN"), process.env.BETTER_AUTH_URL],
    ""
  )

  const token = signInvoicePaymentToken(
    {
      invoiceId: invoice.id,
      keyVersion: invoice.publicPaymentKeyVersion,
      scope: "invoice_payment",
    },
    getPublicInvoicePaymentSecret()
  )

  return buildAbsoluteUrl(origin, `/pay/${encodeURIComponent(token)}`)
}
