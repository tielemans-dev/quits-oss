import { prisma } from "../db"
import { appLogger } from "../observability"
import { getRuntimeExtensions } from "../runtime/extensions"
import { decryptSecret } from "../secrets"
import { expireOpenStripeCheckoutSession, usesStripeConnectCheckout, type StripeCheckoutTarget } from "./stripe"

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
 * Hosted sessions belong to Connect, including a seller's previous account. Self-hosted
 * sessions use the stored BYOK key. A missing session is not proof of expiry: refuse
 * replacement and let settlement jobs retry until its owning account is reachable.
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
  const extensions = getRuntimeExtensions().filter(extension =>
    extension.resolveStripeCheckoutTarget || extension.resolveStripeCheckoutExpiryTargets)
  if (usesStripeConnectCheckout() || extensions.length) {
    if (input.target?.kind === "connect") add(input.target)
    for (const extension of extensions) {
      const current = await extension.resolveStripeCheckoutTarget?.({ organizationId: input.organizationId })
      if (current?.kind === "connect") add(current)
      const historical = await extension.resolveStripeCheckoutExpiryTargets?.({ organizationId: input.organizationId })
      for (const target of historical ?? []) {
        if (target?.kind === "connect") add(target)
      }
    }
  } else {
    if (input.target?.kind === "byok") add(input.target)
    const secretKey = await organizationStripeSecretKey(input.organizationId)
    if (secretKey) add({ kind: "byok", secretKey, webhookSecret: "" })
  }
  if (!targets.length) {
    throw new Error(`Cannot expire Stripe Checkout session ${input.sessionId}: the organization has no Stripe secret key or Connect account`)
  }
  for (const target of targets) {
    const result = await expireOpenStripeCheckoutSession(target.kind === "byok"
      ? { secretKey: target.secretKey, sessionId: input.sessionId }
      : { target, sessionId: input.sessionId })
    if (result !== "missing") return result
  }
  throw new Error(`Cannot locate Stripe Checkout session ${input.sessionId} on any configured account`)
}
