import { prisma } from "../db"
import { appLogger } from "../observability"
import { getRuntimeExtensions } from "../runtime/extensions"
import { decryptSecret } from "../secrets"
import { expireOpenStripeCheckoutSession, type StripeCheckoutTarget } from "./stripe"

/** Expiry needs only the API key, even after the seller removes other BYOK settings. */
export async function organizationStripeSecretKey(organizationId: string) {
  const settings = await prisma.orgSettings.findUnique({
    where: { organizationId },
    select: { stripeSecretKeyEnc: true },
  })
  try {
    return settings?.stripeSecretKeyEnc ? decryptSecret(settings.stripeSecretKeyEnc) : null
  } catch {
    appLogger.child("payments").error("checkout.expire.byok_key_undecryptable", { organizationId })
    return null
  }
}

/**
 * A tracked session can predate an account switch. Search extension accounts regardless of
 * readiness and the stored BYOK key in both directions. A miss on one account proves nothing
 * about the others. Throwing resolvers and Stripe failures must keep checkout blocked/jobs retrying.
 */
export async function expireOrganizationCheckoutSession(input: {
  organizationId: string
  sessionId: string
  target?: StripeCheckoutTarget
}) {
  const targets: StripeCheckoutTarget[] = []
  function add(target: StripeCheckoutTarget) {
    if (!targets.some(existing => existing.kind === "connect" && target.kind === "connect"
      ? existing.stripeAccount === target.stripeAccount
      : existing.kind === "byok" && target.kind === "byok" && existing.secretKey === target.secretKey)) {
      targets.push(target)
    }
  }
  if (input.target) add(input.target)
  for (const extension of getRuntimeExtensions()) {
    const target = await extension.resolveStripeCheckoutTarget?.({ organizationId: input.organizationId })
    if (target) add(target)
  }
  const secretKey = await organizationStripeSecretKey(input.organizationId)
  if (secretKey) add({ kind: "byok", secretKey, webhookSecret: "" })
  if (!targets.length) {
    throw new Error(`Cannot expire Stripe Checkout session ${input.sessionId}: the organization has no Stripe secret key or Connect account`)
  }
  let outcome: "expired" | "not_open" | "missing" = "missing"
  for (const target of targets) {
    const result = await expireOpenStripeCheckoutSession(target.kind === "byok"
      ? { secretKey: target.secretKey, sessionId: input.sessionId }
      : { target, sessionId: input.sessionId })
    if (result === "not_open" || outcome === "missing") outcome = result
  }
  if (outcome === "missing") {
    throw new Error(`Cannot locate Stripe Checkout session ${input.sessionId} on any configured account`)
  }
  return outcome
}
