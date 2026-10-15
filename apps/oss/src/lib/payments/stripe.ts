import type { StripeAccountStatus } from "@quits/contracts/payments"
import Stripe from "stripe"
import { prisma } from "../db"
import { getRuntimeExtensions } from "../runtime/extensions"
import type {
  StripeCheckoutTarget,
  StripeCheckoutTargetContext,
  StripeConnectCheckoutClient,
} from "../runtime/stripe-checkout-target"
import { decryptSecret } from "../secrets"
import { isExactInCurrency, toStripeMinorUnits } from "./stripe-amounts"

export type { StripeCheckoutTarget, StripeCheckoutTargetContext } from "../runtime/stripe-checkout-target"

export type StripePaymentConfigurationSnapshot = {
  stripePublishableKey: string | null
  stripeSecretKeyEnc: string | null
  stripeWebhookSecretEnc: string | null
  /** Cached Connect readiness. Only `active` counts as card payments being configured. */
  stripeAccountStatus?: StripeAccountStatus | null
}

function stripeByokConfigured(snapshot: StripePaymentConfigurationSnapshot) {
  return Boolean(
    snapshot.stripePublishableKey &&
      snapshot.stripeSecretKeyEnc &&
      snapshot.stripeWebhookSecretEnc
  )
}

/** Card payments are configured when BYOK keys are complete or the Connect account is active. */
export function getStripePaymentConfigurationState(
  snapshot: StripePaymentConfigurationSnapshot
) {
  return {
    configured: stripeByokConfigured(snapshot) || snapshot.stripeAccountStatus === "active",
  }
}

export type CardCheckoutBlock = "card_checkout_not_ready" | "balance_not_representable_in_currency"

/** Shared page/checkout gate: complete BYOK keys or active Connect, and an exact currency amount. */
export function assessCardCheckout(input: {
  configuration: StripePaymentConfigurationSnapshot | null | undefined
  amount: number
  currency: string
}): { ready: true } | { ready: false; reason: CardCheckoutBlock } {
  if (!input.configuration || !getStripePaymentConfigurationState(input.configuration).configured) {
    return { ready: false, reason: "card_checkout_not_ready" }
  }
  if (!isExactInCurrency(input.amount, input.currency)) {
    return { ready: false, reason: "balance_not_representable_in_currency" }
  }
  return { ready: true }
}

export function getStripePaymentCredentials(
  snapshot: StripePaymentConfigurationSnapshot
) {
  if (!stripeByokConfigured(snapshot)) {
    return null
  }

  return {
    publishableKey: snapshot.stripePublishableKey ?? "",
    secretKey: decryptSecret(snapshot.stripeSecretKeyEnc ?? ""),
    webhookSecret: decryptSecret(snapshot.stripeWebhookSecretEnc ?? ""),
  }
}

export function createStripeClient(secretKey: string, options?: { timeoutMs?: number }) {
  return new Stripe(secretKey, options?.timeoutMs ? { timeout: options.timeoutMs } : undefined)
}

/** A platform Stripe client must be usable as a connect checkout client. */
type _SdkFitsConnectClient = Stripe extends StripeConnectCheckoutClient ? true : never
const _sdkFitsConnectClient: _SdkFitsConnectClient = true
void _sdkFitsConnectClient

/**
 * The first extension that returns a target wins. Otherwise the organization's own
 * Stripe keys are used, and only when publishable key, secret key and webhook secret
 * are all stored. `connectReady: false` skips Connect for new charges.
 * Expiry leaves readiness unset so existing Connect sessions remain accessible.
 */
export async function resolveStripeCheckoutTarget(
  context: StripeCheckoutTargetContext,
  options?: { connectReady?: boolean }
): Promise<StripeCheckoutTarget | null> {
  for (const extension of getRuntimeExtensions()) {
    if (!extension.resolveStripeCheckoutTarget) continue
    const target = await extension.resolveStripeCheckoutTarget(context)
    if (!target) continue
    if (target.kind === "connect" && options?.connectReady === false) continue
    return target
  }
  return defaultByokStripeCheckoutTarget(context.organizationId)
}

async function defaultByokStripeCheckoutTarget(
  organizationId: string
): Promise<StripeCheckoutTarget | null> {
  const settings = await prisma.orgSettings.findUnique({
    where: { organizationId },
    select: {
      stripePublishableKey: true,
      stripeSecretKeyEnc: true,
      stripeWebhookSecretEnc: true,
    },
  })
  const credentials = getStripePaymentCredentials({
    stripePublishableKey: settings?.stripePublishableKey ?? null,
    stripeSecretKeyEnc: settings?.stripeSecretKeyEnc ?? null,
    stripeWebhookSecretEnc: settings?.stripeWebhookSecretEnc ?? null,
  })
  if (!credentials) return null
  return {
    kind: "byok",
    secretKey: credentials.secretKey,
    webhookSecret: credentials.webhookSecret,
  }
}

/**
 * Expiring a session runs right after a payment is recorded, before the response is sent; a slow
 * Stripe must not hold that up for long. A timed-out expiry is retried by the job runner.
 */
const EXPIRE_TIMEOUT_MS = 10_000

type InvoiceCheckoutSessionInput = {
  invoice: {
    id: string
    number: string
    organizationId: string
    currency: string
  }
  /** What the customer still owes: total minus payments and credit notes, in major units. */
  amountDue: number
  successUrl: string
  cancelUrl: string
}

/**
 * Direct charge on the resolved account. No application fee, and no payment_method_types, so
 * Stripe keeps dynamic payment methods (including MobilePay where the account has them).
 */
type DirectChargeCheckoutParams = Omit<
  Stripe.Checkout.SessionCreateParams,
  "payment_method_types" | "payment_intent_data"
>

function invoiceCheckoutSessionParams(input: InvoiceCheckoutSessionInput): DirectChargeCheckoutParams {
  return {
    mode: "payment",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.invoice.id,
    metadata: {
      invoiceId: input.invoice.id,
      organizationId: input.invoice.organizationId,
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.invoice.currency.toLowerCase(),
          unit_amount: toStripeMinorUnits(input.amountDue, input.invoice.currency),
          product_data: {
            name: `Invoice ${input.invoice.number}`,
          },
        },
      },
    ],
  }
}

function targetForCheckout(input: {
  credentials?: ReturnType<typeof getStripePaymentCredentials>
  target?: StripeCheckoutTarget
}): StripeCheckoutTarget {
  if (input.target) return requireConnectAccount(input.target)
  if (!input.credentials) {
    throw new Error("Stripe payment credentials are not configured")
  }
  return {
    kind: "byok",
    secretKey: input.credentials.secretKey,
    webhookSecret: input.credentials.webhookSecret,
  }
}

function targetForExpiry(input: {
  secretKey?: string
  target?: StripeCheckoutTarget
}): StripeCheckoutTarget {
  if (input.target) return requireConnectAccount(input.target)
  if (!input.secretKey) {
    throw new Error("Stripe payment credentials are not configured")
  }
  return { kind: "byok", secretKey: input.secretKey, webhookSecret: "" }
}

function requireConnectAccount(target: StripeCheckoutTarget): StripeCheckoutTarget {
  if (target.kind === "connect" && !target.stripeAccount.trim()) {
    throw new Error("Stripe Connect checkout requires a connected account")
  }
  return target
}

/** Stripe-Account header for a direct charge. Omitted for BYOK, which uses the org's own key. */
function connectRequestOptions(stripeAccount: string, timeoutMs?: number): { stripeAccount: string; timeout?: number } {
  return timeoutMs ? { stripeAccount, timeout: timeoutMs } : { stripeAccount }
}

export async function createStripeInvoiceCheckoutSession(
  input: InvoiceCheckoutSessionInput & {
    credentials?: ReturnType<typeof getStripePaymentCredentials>
    target?: StripeCheckoutTarget
  }
) {
  const target = targetForCheckout(input)
  const params = invoiceCheckoutSessionParams(input)
  if (target.kind === "connect") {
    return target.client.checkout.sessions.create(params, connectRequestOptions(target.stripeAccount))
  }
  return createStripeClient(target.secretKey).checkout.sessions.create(params)
}

export type CheckoutSessionExpiry = "expired" | "not_open" | "missing"

/**
 * An injected Connect client may be a different copy of the Stripe SDK, so its errors are not
 * instances of this package's `Stripe.errors.StripeInvalidRequestError`. The API fields are
 * stable: `type` / `rawType` of `invalid_request_error`, and stripe-node's own `type` of
 * `StripeInvalidRequestError`, plus `code` of `resource_missing` when the session is gone.
 */
function stripeErrorFields(error: unknown) {
  if (typeof error !== "object" || error === null) return null
  const value = error as { type?: unknown; code?: unknown; rawType?: unknown; raw?: unknown }
  const type = typeof value.type === "string" ? value.type : undefined
  const code = typeof value.code === "string" ? value.code : undefined
  const raw = typeof value.raw === "object" && value.raw !== null ? value.raw as { type?: unknown } : undefined
  const rawType = typeof value.rawType === "string"
    ? value.rawType
    : typeof raw?.type === "string"
      ? raw.type
      : undefined
  if (type === undefined && code === undefined && rawType === undefined) return null
  return { type, code, rawType }
}

function isInvalidRequest(error: unknown) {
  const fields = stripeErrorFields(error)
  if (!fields) return false
  return fields.type === "invalid_request_error"
    || fields.rawType === "invalid_request_error"
    || fields.type === "StripeInvalidRequestError"
}

function isMissingResource(error: unknown) {
  return isInvalidRequest(error) && stripeErrorFields(error)?.code === "resource_missing"
}

/**
 * Expires a Checkout session if it can still be paid, so a customer cannot pay an amount that is
 * no longer owed. A session that was completed, already expired, or never existed (e.g. created
 * under a Stripe key that has since been replaced) needs nothing and is reported as such.
 * A connect target expires the session on that connected account.
 */
export async function expireOpenStripeCheckoutSession(input: {
  secretKey?: string
  target?: StripeCheckoutTarget
  sessionId: string
}): Promise<CheckoutSessionExpiry> {
  const target = targetForExpiry(input)
  const sessionApi = checkoutSessionApi(target)
  try {
    await sessionApi.expire(input.sessionId)
    return "expired"
  } catch (error) {
    if (isMissingResource(error)) {
      return "missing"
    }
    if (!isInvalidRequest(error)) {
      throw error
    }
    // Only open sessions can be expired; find out whether this one is no longer open.
    let session: { status: string | null }
    try {
      session = await sessionApi.retrieve(input.sessionId)
    } catch (retrieveError) {
      if (isMissingResource(retrieveError)) {
        return "missing"
      }
      throw retrieveError
    }
    if (session.status !== "open") {
      return "not_open"
    }
    throw error
  }
}

function checkoutSessionApi(target: StripeCheckoutTarget) {
  if (target.kind === "connect") {
    const options = connectRequestOptions(target.stripeAccount, EXPIRE_TIMEOUT_MS)
    return {
      expire: (sessionId: string) => target.client.checkout.sessions.expire(sessionId, options),
      retrieve: (sessionId: string) => target.client.checkout.sessions.retrieve(sessionId, options),
    }
  }
  const stripe = createStripeClient(target.secretKey, { timeoutMs: EXPIRE_TIMEOUT_MS })
  return {
    expire: (sessionId: string) => stripe.checkout.sessions.expire(sessionId),
    retrieve: (sessionId: string) => stripe.checkout.sessions.retrieve(sessionId),
  }
}

export function constructStripeWebhookEvent(input: {
  payload: string
  signature: string
  webhookSecret: string
}) {
  const stripe = createStripeClient("sk_test_placeholder_123456789012345")
  return stripe.webhooks.constructEvent(
    input.payload,
    input.signature,
    input.webhookSecret
  )
}
