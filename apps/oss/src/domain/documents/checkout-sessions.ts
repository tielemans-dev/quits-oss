import { Effect } from "effect"
import { z } from "zod"
import { prisma } from "../../lib/db"
import { appLogger } from "../../lib/observability"
import { expireOpenStripeCheckoutSession, resolveStripeCheckoutTarget } from "../../lib/payments/stripe"
import { decryptSecret } from "../../lib/secrets"
import { registerJobHandler, TerminalJobError } from "../jobs"
import { Command, Db } from "../services"

/*
 * Stale Stripe Checkout sessions
 * ------------------------------
 * A Checkout session charges the balance due when the customer opened it. When the balance
 * changes afterwards (a bank transfer or a credit note is recorded, a payment is voided), the
 * invoice's open session would charge the old amount, so it is expired. The public payment page
 * then opens a new session for the current balance.
 *
 * Stripe is called from a job, after the settlement change commits: a Stripe outage must never
 * stop anyone recording a payment, and the job retries until Stripe answers.
 */

export const EXPIRE_CHECKOUT_SESSION_JOB = "payments.expire_checkout_session"

const paymentsLogger = appLogger.child("payments")

const payloadSchema = z.object({
  invoiceId: z.string().min(1),
  checkoutSessionId: z.string().min(1),
})

/**
 * Queues expiry of the invoice's open Checkout session, if it has one that no payment came from.
 * Call in the transaction that changed the balance due.
 */
export const expireStaleCheckoutSession = (invoice: { id: string; stripeCheckoutSessionId: string | null }) =>
  Effect.gen(function* () {
    const checkoutSessionId = invoice.stripeCheckoutSessionId
    if (!checkoutSessionId) {
      return
    }
    const db = yield* Db
    const command = yield* Command
    // The session a Stripe payment came from is already complete; there is nothing to expire.
    const paid = yield* Effect.promise(() =>
      db.payment.findUnique({ where: { stripeCheckoutSessionId: checkoutSessionId }, select: { id: true } })
    )
    if (paid) {
      return
    }
    command.enqueue({
      type: EXPIRE_CHECKOUT_SESSION_JOB,
      payload: { invoiceId: invoice.id, checkoutSessionId },
      // Once expired a session stays expired, so one job per session is enough.
      dedupeKey: `${EXPIRE_CHECKOUT_SESSION_JOB}:${checkoutSessionId}`,
    })
  })

/**
 * A Stripe webhook is about to record `checkoutSessionId` as the invoice's session. If the invoice
 * tracked another session (one the customer opened after starting an asynchronous payment, say),
 * that one is expired before it is forgotten, since nothing could expire it later.
 */
export const expireReplacedCheckoutSession = (
  invoice: { id: string; stripeCheckoutSessionId: string | null },
  checkoutSessionId: string
) =>
  invoice.stripeCheckoutSessionId && invoice.stripeCheckoutSessionId !== checkoutSessionId
    ? expireStaleCheckoutSession(invoice)
    : Effect.void

/**
 * Loads the organization's Stripe API secret key, or null when none is stored. Expiring a session
 * needs only this key, so it is read on its own: a payment configuration that is incomplete
 * otherwise (no webhook secret, say) must not stop a stale session from being expired.
 */
export async function organizationStripeSecretKey(organizationId: string) {
  const settings = await prisma.orgSettings.findUnique({
    where: { organizationId },
    select: { stripeSecretKeyEnc: true },
  })
  return settings?.stripeSecretKeyEnc ? decryptSecret(settings.stripeSecretKeyEnc) : null
}

/*
 * Registered next to the code that enqueues it, so every process that changes a settlement (UI,
 * agents, webhooks) can run the job right after the transaction commits.
 */
registerJobHandler(EXPIRE_CHECKOUT_SESSION_JOB, async (job) => {
  const parsed = payloadSchema.safeParse(job.payload)
  if (!parsed.success) {
    throw new TerminalJobError(`Invalid ${EXPIRE_CHECKOUT_SESSION_JOB} payload: ${parsed.error.message}`)
  }
  const { invoiceId, checkoutSessionId } = parsed.data
  const target = await resolveStripeCheckoutTarget({ organizationId: job.organizationId })
  const outcome = await expireResolvedCheckoutSession({
    organizationId: job.organizationId,
    invoiceId,
    checkoutSessionId,
    target,
  })
  paymentsLogger.info("checkout.expire.done", {
    organizationId: job.organizationId,
    invoiceId,
    checkoutSessionId,
    outcome,
  })
})

/**
 * Connect sessions expire on the connected account. BYOK uses the stored secret key, including
 * when the rest of the Stripe setup is incomplete: a missing webhook secret must not leave a
 * payable session open.
 */
async function expireResolvedCheckoutSession(input: {
  organizationId: string
  invoiceId: string
  checkoutSessionId: string
  target: Awaited<ReturnType<typeof resolveStripeCheckoutTarget>>
}) {
  if (input.target?.kind === "connect") {
    return expireOpenStripeCheckoutSession({ target: input.target, sessionId: input.checkoutSessionId })
  }
  const secretKey =
    input.target?.kind === "byok"
      ? input.target.secretKey
      : await organizationStripeSecretKey(input.organizationId)
  if (!secretKey) {
    // The session was opened with a key that has since been removed and may still be payable.
    // Fail visibly and retry, so restoring the key lets the expiry go through.
    paymentsLogger.error("checkout.expire.no_secret_key", {
      organizationId: input.organizationId,
      invoiceId: input.invoiceId,
      checkoutSessionId: input.checkoutSessionId,
    })
    throw new Error(
      `Cannot expire Stripe Checkout session ${input.checkoutSessionId}: the organization has no Stripe secret key`
    )
  }
  return expireOpenStripeCheckoutSession({ secretKey, sessionId: input.checkoutSessionId })
}
