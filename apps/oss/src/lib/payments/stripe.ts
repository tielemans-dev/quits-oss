import Stripe from "stripe"
import { prisma } from "../db"
import { getRuntimeExtensions } from "../runtime/extensions"
import type {
  StripeCheckoutTarget,
  StripeCheckoutTargetContext,
  StripeConnectCheckoutClient,
} from "../runtime/stripe-checkout-target"
import { decryptSecret } from "../secrets"
import { toStripeMinorUnits } from "./stripe-amounts"

export type { StripeCheckoutTarget, StripeCheckoutTargetContext } from "../runtime/stripe-checkout-target"

export type StripePaymentConfigurationSnapshot = {
  stripePublishableKey: string | null
  stripeSecretKeyEnc: string | null
  stripeWebhookSecretEnc: string | null
}

export function getStripePaymentConfigurationState(
  snapshot: StripePaymentConfigurationSnapshot
) {
  return {
    configured: Boolean(
      snapshot.stripePublishableKey &&
        snapshot.stripeSecretKeyEnc &&
        snapshot.stripeWebhookSecretEnc
    ),
  }
}

export function getStripePaymentCredentials(
  snapshot: StripePaymentConfigurationSnapshot
) {
  if (!getStripePaymentConfigurationState(snapshot).configured) {
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
 * are all stored.
 */
export async function resolveStripeCheckoutTarget(
  context: StripeCheckoutTargetContext
): Promise<StripeCheckoutTarget | null> {
  for (const extension of getRuntimeExtensions()) {
    if (!extension.resolveStripeCheckoutTarget) continue
    const target = await extension.resolveStripeCheckoutTarget(context)
    if (target) return target
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

function isMissingResource(error: unknown) {
  return error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing"
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
    if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) {
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
