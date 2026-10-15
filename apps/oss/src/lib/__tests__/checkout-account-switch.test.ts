import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { JobHandler } from "../../domain/jobs"
import { EXPIRE_CHECKOUT_SESSION_JOB } from "../../domain/documents/checkout-sessions"
import { expireOrganizationCheckoutSession } from "../payments/checkout-sessions"
import { resolvePublicInvoiceCheckout } from "../payments/public-checkout"
import { signInvoicePaymentToken } from "../payments/public"
import { setRuntimeExtensions } from "../runtime/extensions"
import { resolveStripeCheckoutTarget } from "../payments/stripe"
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

  it.each(["none", "pending", "restricted", "active"])("checks cached %s readiness when no caller snapshot is supplied", async status => {
    state.settings.stripeAccountStatus = status
    expect(await resolveStripeCheckoutTarget({ organizationId: invoice.organizationId })).toBe(status === "active" ? connect : null)
  })

  it("does not expire through BYOK when hosted has no Connect extension", async () => {
    vi.stubEnv("QUITS_DISTRIBUTION", "cloud")
    setRuntimeExtensions([])
    await expect(expireOrganizationCheckoutSession({ organizationId: invoice.organizationId, sessionId: "cs_previous" })).rejects.toThrow("no Stripe secret key or Connect account")
    expect(state.byokExpire).not.toHaveBeenCalled()
  })

  it("expires the tracked Connect session before opening another on the seller account", async () => {
    state.create.mockImplementation(async (_params, options) => {
      expect(state.connectExpire).toHaveBeenCalledExactlyOnceWith("cs_previous", { stripeAccount: connect.stripeAccount, timeout: 10_000 })
      expect(options).toEqual({ stripeAccount: connect.stripeAccount })
      return { id: "cs_new", url: "https://checkout.example/new" }
    })
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: "redirect" })
    expect(state.byokExpire).not.toHaveBeenCalled()
  })

  it("finds the session on a previous Connect account without charging it", async () => {
    const previous = { ...connect, stripeAccount: "acct_previous" }
    setRuntimeExtensions([{
      id: "connect", resolveStripeCheckoutTarget: () => connect,
      resolveStripeCheckoutExpiryTargets: () => [previous],
    }])
    state.connectExpire.mockImplementation(async (_id, options) => {
      if (options.stripeAccount === connect.stripeAccount) throw missing()
      return { status: "expired" }
    })
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: "redirect" })
    expect(state.connectExpire).toHaveBeenCalledTimes(2)
    expect(state.connectExpire).toHaveBeenLastCalledWith("cs_previous", expect.objectContaining({ stripeAccount: "acct_previous" }))
    expect(state.create).toHaveBeenCalledWith(expect.anything(), { stripeAccount: connect.stripeAccount })
    expect(state.byokExpire).not.toHaveBeenCalled()
  })

  it.each(["pending", "restricted"])("refuses hosted checkout when Connect is %s but still expires its old session", async status => {
    state.settings.stripeAccountStatus = status
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "unavailable", url: null })
    expect(state.create).not.toHaveBeenCalled()
    await state.handler!({ id: "job", organizationId: invoice.organizationId, attempts: 1, createdAt: new Date(),
      claimToken: "claim", payload: { invoiceId: invoice.id, checkoutSessionId: "cs_previous" } })
    expect(EXPIRE_CHECKOUT_SESSION_JOB).toBe("payments.expire_checkout_session")
    expect(state.connectExpire).toHaveBeenCalledTimes(1)
    expect(state.byokExpire).not.toHaveBeenCalled()
  })

  it("includes the restricted current account when the expiry hook lists only previous accounts", async () => {
    state.settings.stripeAccountStatus = "restricted"
    setRuntimeExtensions([{
      id: "connect", resolveStripeCheckoutTarget: () => connect,
      resolveStripeCheckoutExpiryTargets: () => [{ ...connect, stripeAccount: "acct_previous" }],
    }])
    state.connectExpire.mockImplementation(async (_id, options) => {
      if (options.stripeAccount !== connect.stripeAccount) throw missing()
      return { status: "expired" }
    })
    await state.handler!({ id: "job", organizationId: invoice.organizationId, attempts: 1, createdAt: new Date(),
      claimToken: "claim", payload: { invoiceId: invoice.id, checkoutSessionId: "cs_previous" } })
    expect(state.connectExpire).toHaveBeenCalledExactlyOnceWith("cs_previous", expect.objectContaining({ stripeAccount: connect.stripeAccount }))
    expect(state.byokExpire).not.toHaveBeenCalled()
  })

  it("recognizes a located session that is no longer open", async () => {
    state.connectExpire.mockRejectedValue(Object.assign(new Error("not open"), { type: "StripeInvalidRequestError" }))
    state.retrieve.mockResolvedValue({ status: "complete" })
    await expect(expireOrganizationCheckoutSession({ organizationId: invoice.organizationId, sessionId: "cs_previous" })).resolves.toBe("not_open")
    expect(state.byokExpire).not.toHaveBeenCalled()
  })

  it("still expires Connect when leftover BYOK ciphertext cannot decrypt", async () => {
    state.settings.stripeSecretKeyEnc = "undecryptable"
    expect(await resolvePublicInvoiceCheckout(token)).toMatchObject({ status: "redirect" })
    expect(state.connectExpire).toHaveBeenCalledTimes(1)
    expect(state.byokExpire).not.toHaveBeenCalled()
  })

  it("supports expiry before an extension adopts the historical account hook", async () => {
    setRuntimeExtensions([{ id: "connect", resolveStripeCheckoutTarget: () => connect }])
    state.settings.stripeAccountStatus = "restricted"
    await expect(expireOrganizationCheckoutSession({ organizationId: invoice.organizationId, sessionId: "cs_previous" })).resolves.toBe("expired")
    expect(state.connectExpire).toHaveBeenCalledTimes(1)
    expect(state.byokExpire).not.toHaveBeenCalled()
  })

  it.each(["missing", "outage"])("refuses replacement after Connect reports %s, even with usable BYOK keys", async failure => {
    state.connectExpire.mockRejectedValue(failure === "missing" ? missing() : new Error("Stripe unavailable"))
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "unavailable", url: null })
    expect(state.create).not.toHaveBeenCalled()
    expect(state.byokExpire).not.toHaveBeenCalled()
  })

  it("refuses replacement if historical account discovery fails", async () => {
    setRuntimeExtensions([{
      id: "connect", resolveStripeCheckoutTarget: () => connect,
      resolveStripeCheckoutExpiryTargets: () => { throw new Error("account lookup unavailable") },
    }])
    expect(await resolvePublicInvoiceCheckout(token)).toEqual({ status: "unavailable", url: null })
    expect(state.create).not.toHaveBeenCalled()
  })

  it("does not use BYOK expiry targets supplied by a hosted extension", async () => {
    setRuntimeExtensions([{
      id: "connect", resolveStripeCheckoutTarget: () => null,
      resolveStripeCheckoutExpiryTargets: () => [byok],
    }])
    await expect(expireOrganizationCheckoutSession({ organizationId: invoice.organizationId, sessionId: "cs_previous" })).rejects.toThrow("no Stripe secret key or Connect account")
    expect(state.byokExpire).not.toHaveBeenCalled()
  })

  it("expires self-hosted BYOK with incomplete settings in the settlement job", async () => {
    setRuntimeExtensions([])
    state.settings.stripeWebhookSecretEnc = ""
    await state.handler!({ id: "job", organizationId: invoice.organizationId, attempts: 1, createdAt: new Date(),
      claimToken: "claim", payload: { invoiceId: invoice.id, checkoutSessionId: "cs_previous" } })
    expect(state.byokExpire).toHaveBeenCalledExactlyOnceWith("cs_previous")
    expect(state.connectExpire).not.toHaveBeenCalled()
  })

  it.each(["", "undecryptable"])("retries self-hosted expiry after an unavailable key is restored", async key => {
    setRuntimeExtensions([])
    state.settings.stripeSecretKeyEnc = key
    await expect(expireOrganizationCheckoutSession({ organizationId: invoice.organizationId, sessionId: "cs_previous" })).rejects.toThrow("no Stripe secret key")
    state.settings.stripeSecretKeyEnc = encryptSecret(byok.secretKey)
    await expect(expireOrganizationCheckoutSession({ organizationId: invoice.organizationId, sessionId: "cs_previous" })).resolves.toBe("expired")
  })
})
