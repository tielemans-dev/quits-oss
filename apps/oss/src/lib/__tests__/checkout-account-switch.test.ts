import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { JobHandler } from "../../domain/jobs"
import { EXPIRE_CHECKOUT_SESSION_JOB } from "../../domain/documents/checkout-sessions"
import { expireOrganizationCheckoutSession } from "../payments/checkout-sessions"
import { resolvePublicInvoiceCheckout } from "../payments/public-checkout"
import { signInvoicePaymentToken } from "../payments/public"
import { setRuntimeExtensions } from "../runtime/extensions"
import { encryptSecret } from "../secrets"

const state = vi.hoisted(() => ({
  byokExpire: vi.fn(), connectExpire: vi.fn(), retrieve: vi.fn(), create: vi.fn(),
  handler: undefined as JobHandler | undefined,
  settings: { stripePublishableKey: "pk_test", stripeSecretKeyEnc: "", stripeWebhookSecretEnc: "", stripeAccountStatus: "active" },
}))
const invoice = {
  id: "inv_switch", organizationId: "org_switch", number: "INV-1", currency: "DKK",
  status: "sent", paymentStatus: "unpaid", totalGross: 100, amountPaid: 0, amountCredited: 0,
  stripeCheckoutSessionId: "cs_previous" as string | null, organization: { settings: state.settings },
}
vi.mock("../db", () => ({ prisma: {
  orgSettings: { findUnique: async () => state.settings },
  invoice: { findFirst: async () => invoice, findUniqueOrThrow: async () => invoice, updateMany: async () => ({ count: 1 }) },
  payment: { findUnique: async () => null },
} }))
vi.mock("stripe", () => ({ default: class Stripe {
  constructor(secretKey: string) { expect(secretKey).toBe("sk_test_switch") }
  checkout = { sessions: { create: state.create, expire: state.byokExpire, retrieve: state.retrieve } }
} }))
vi.mock("../../domain/jobs", () => ({
  registerJobHandler: (type: string, handler: JobHandler) => {
    if (type === "payments.expire_checkout_session") state.handler = handler
  },
  TerminalJobError: class extends Error {},
}))

const connect = {
  kind: "connect" as const, stripeAccount: "acct_switch",
  client: { checkout: { sessions: { create: state.create, expire: state.connectExpire, retrieve: state.retrieve } } },
}
const byok = { kind: "byok" as const, secretKey: "sk_test_switch", webhookSecret: "whsec_switch" }
const secret = "checkout-switch-public-secret"
const token = signInvoicePaymentToken({ invoiceId: invoice.id, keyVersion: 1, scope: "invoice_payment" }, secret)
const missing = () => Object.assign(new Error("No such session"), { type: "StripeInvalidRequestError", code: "resource_missing" })

describe("checkout sessions after switching Stripe accounts", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_SECRET", "checkout-switch-encryption-secret-123456")
    vi.stubEnv("QUITS_PUBLIC_PAYMENT_SECRET", secret)
    invoice.stripeCheckoutSessionId = "cs_previous"
    Object.assign(state.settings, {
      stripeAccountStatus: "active",
      stripeSecretKeyEnc: encryptSecret(byok.secretKey), stripeWebhookSecretEnc: encryptSecret(byok.webhookSecret),
    })
    state.byokExpire.mockReset().mockResolvedValue({ status: "expired" })
    state.connectExpire.mockReset().mockResolvedValue({ status: "expired" })
    state.retrieve.mockReset()
    state.create.mockReset().mockResolvedValue({ id: "cs_new", url: "https://checkout.example/new" })
    setRuntimeExtensions([{
      id: "connect",
      resolveStripeCheckoutTarget: () => connect,
      resolveStripeCheckoutExpiryTargets: () => [connect],
    }])
  })
  afterEach(() => { setRuntimeExtensions([]); vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it.each(["byok-to-connect", "connect-to-byok"])("expires the old %s session before creating checkout", async direction => {
    const previous = { ...connect, stripeAccount: "acct_previous" }
    if (direction === "byok-to-connect") state.connectExpire.mockRejectedValue(missing())
    else {
      state.byokExpire.mockRejectedValue(missing())
      // Restricted Connect is not charged. The old session is only on the historical account.
      state.settings.stripeAccountStatus = "restricted"
      setRuntimeExtensions([{
        id: "connect",
        resolveStripeCheckoutTarget: () => connect,
        resolveStripeCheckoutExpiryTargets: () => [previous],
      }])
    }
    const expiredAccount = direction === "byok-to-connect" ? connect.stripeAccount : previous.stripeAccount
    state.create.mockImplementation(async (_params, options) => {
      expect(options?.stripeAccount).toBe(direction === "byok-to-connect" ? connect.stripeAccount : undefined)
      expect(state.byokExpire).toHaveBeenCalledWith("cs_previous")
      expect(state.connectExpire).toHaveBeenCalledWith("cs_previous", expect.objectContaining({ stripeAccount: expiredAccount }))
      return { id: "cs_new", url: "https://checkout.example/new" }
    })
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: "redirect" })
    expect(state.byokExpire).toHaveBeenCalledTimes(1)
    expect(state.connectExpire).toHaveBeenCalledTimes(1)
  })

  it("expires the BYOK-owned fallback session before opening a Connect-owned session after activation", async () => {
    const sessions: Record<string, { owner: string; open: boolean }> = {}
    const expire = (owner: string, id: string) => {
      if (sessions[id]?.owner !== owner) throw missing()
      sessions[id].open = false
      return { status: "expired" }
    }
    state.byokExpire.mockImplementation(id => expire(byok.secretKey, id))
    state.connectExpire.mockImplementation((id, options) => expire(options.stripeAccount, id))
    state.create.mockImplementation(async (_params, options?: { stripeAccount: string }) => {
      const owner = options?.stripeAccount ?? byok.secretKey
      const id = options ? "cs_connect" : "cs_byok"
      if (options) expect(sessions.cs_byok).toEqual({ owner: byok.secretKey, open: false })
      sessions[id] = { owner, open: true }
      return { id, url: `https://checkout.example/${id}` }
    })
    invoice.stripeCheckoutSessionId = null
    state.settings.stripeAccountStatus = "pending"
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: "redirect" })
    expect(sessions.cs_byok).toEqual({ owner: byok.secretKey, open: true })
    invoice.stripeCheckoutSessionId = "cs_byok"
    state.settings.stripeAccountStatus = "active"
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: "redirect" })
    expect(sessions).toEqual({
      cs_byok: { owner: byok.secretKey, open: false },
      cs_connect: { owner: connect.stripeAccount, open: true },
    })
  })

  it("still expires Connect sessions when leftover BYOK ciphertext cannot decrypt", async () => {
    state.settings.stripeSecretKeyEnc = "undecryptable"
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: "redirect" })
    expect(state.connectExpire).toHaveBeenCalledTimes(1)
    expect(state.byokExpire).not.toHaveBeenCalled()
  })

  it("blocks a new charge on an expiry outage, even when the current account reports missing", async () => {
    state.connectExpire.mockRejectedValue(missing())
    state.byokExpire.mockRejectedValue(new Error("Stripe unavailable"))
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "unavailable", url: null })
    expect(state.create).not.toHaveBeenCalled()
  })

  it("does not assume an unlocatable session is safe to replace", async () => {
    state.connectExpire.mockRejectedValue(missing())
    state.byokExpire.mockRejectedValue(missing())
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: "unavailable" })
    expect(state.create).not.toHaveBeenCalled()
  })

  it.each(["byok", "connect"])("searches other accounts even when %s reports not_open", async account => {
    const expire = account === "byok" ? state.byokExpire : state.connectExpire
    expire.mockRejectedValue(Object.assign(new Error("not open"), { type: "StripeInvalidRequestError" }))
    state.retrieve.mockResolvedValue({ status: "complete" })
    expect(await expireOrganizationCheckoutSession({ organizationId: invoice.organizationId, sessionId: "cs_previous" })).toBe("not_open")
    expect(state.byokExpire).toHaveBeenCalledWith("cs_previous")
    expect(state.connectExpire).toHaveBeenCalledWith("cs_previous", expect.objectContaining({ stripeAccount: "acct_switch" }))
  })

  it("uses the same account search in the settlement expiry job, with an incomplete BYOK setup", async () => {
    state.settings.stripeWebhookSecretEnc = ""
    state.connectExpire.mockRejectedValue(missing())
    await state.handler!({ id: "job", organizationId: invoice.organizationId, attempts: 1, createdAt: new Date(),
      claimToken: "claim", payload: { invoiceId: invoice.id, checkoutSessionId: "cs_previous" } })
    expect(EXPIRE_CHECKOUT_SESSION_JOB).toBe("payments.expire_checkout_session")
    expect(state.byokExpire).toHaveBeenCalledWith("cs_previous")
  })

  it("requires recoverable credentials so the expiry job retries after keys are restored", async () => {
    setRuntimeExtensions([])
    state.settings.stripeSecretKeyEnc = ""
    await expect(expireOrganizationCheckoutSession({ organizationId: invoice.organizationId, sessionId: "cs_previous" })).rejects.toThrow("no Stripe secret key")
    state.settings.stripeSecretKeyEnc = encryptSecret(byok.secretKey)
    await expect(expireOrganizationCheckoutSession({ organizationId: invoice.organizationId, sessionId: "cs_previous" })).resolves.toBe("expired")
  })

})
