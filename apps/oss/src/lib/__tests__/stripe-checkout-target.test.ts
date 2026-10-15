import { afterEach, describe, expect, it, vi } from "vitest"
import { setRuntimeExtensions } from "../runtime/extensions"
import type { StripeConnectCheckoutClient } from "../runtime/stripe-checkout-target"
import {
  createStripeInvoiceCheckoutSession,
  expireOpenStripeCheckoutSession,
  resolveStripeCheckoutTarget,
} from "../payments/stripe"

vi.mock("../db", () => ({
  prisma: { orgSettings: { findUnique: async () => null } },
}))

const stripeAccount = "acct_connected"

function connectClient() {
  const sessions = {
    create: vi.fn(),
    expire: vi.fn(),
    retrieve: vi.fn(),
  }
  return { sessions, client: { checkout: { sessions } } as unknown as StripeConnectCheckoutClient }
}

const invoice = {
  id: "inv_1",
  number: "INV-1",
  organizationId: "org_1",
  currency: "DKK",
}

describe("Stripe Connect checkout target", () => {
  afterEach(() => {
    setRuntimeExtensions([])
  })

  it("creates a direct charge on the connected account", async () => {
    const { client, sessions } = connectClient()
    sessions.create.mockResolvedValue({ id: "cs_123", url: "https://checkout.stripe.test/cs_123" })

    await createStripeInvoiceCheckoutSession({
      target: { kind: "connect", client, stripeAccount },
      invoice,
      amountDue: 100,
      successUrl: "https://app.example/pay/ok",
      cancelUrl: "https://app.example/pay/cancel",
    })

    expect(sessions.create).toHaveBeenCalledTimes(1)
    const [params, options] = sessions.create.mock.calls[0]
    expect(options).toEqual({ stripeAccount })
    expect(params).toMatchObject({
      mode: "payment",
      line_items: [{ price_data: { currency: "dkk", unit_amount: 10_000 } }],
    })
    expect(params).not.toHaveProperty("payment_method_types")
    expect(params).not.toHaveProperty("application_fee_amount")
    expect(params).not.toHaveProperty("payment_intent_data")
  })

  it("classifies expire errors from another Stripe installation by type and code", async () => {
    const { client, sessions } = connectClient()
    const foreignInvalidRequest = (fields: { code?: string; message: string }) =>
      Object.assign(new Error(fields.message), {
        type: "StripeInvalidRequestError",
        rawType: "invalid_request_error",
        code: fields.code,
      })

    sessions.expire.mockRejectedValueOnce(
      foreignInvalidRequest({ code: "resource_missing", message: "No such checkout.session" })
    )
    await expect(
      expireOpenStripeCheckoutSession({
        target: { kind: "connect", client, stripeAccount },
        sessionId: "cs_foreign",
      })
    ).resolves.toBe("missing")
    expect(sessions.retrieve).not.toHaveBeenCalled()

    sessions.expire.mockRejectedValueOnce(
      Object.assign(new Error("No such checkout.session"), {
        type: "invalid_request_error",
        code: "resource_missing",
      })
    )
    await expect(
      expireOpenStripeCheckoutSession({
        target: { kind: "connect", client, stripeAccount },
        sessionId: "cs_foreign",
      })
    ).resolves.toBe("missing")

    sessions.expire.mockRejectedValueOnce(
      foreignInvalidRequest({ message: "This Checkout Session has a status of complete and cannot be expired" })
    )
    sessions.retrieve.mockResolvedValueOnce({ id: "cs_foreign", status: "complete" })
    await expect(
      expireOpenStripeCheckoutSession({
        target: { kind: "connect", client, stripeAccount },
        sessionId: "cs_foreign",
      })
    ).resolves.toBe("not_open")
    expect(sessions.retrieve).toHaveBeenCalledWith(
      "cs_foreign",
      expect.objectContaining({ stripeAccount })
    )
  })

  it("expires the session on the connected account", async () => {
    const { client, sessions } = connectClient()
    sessions.expire.mockResolvedValue({ id: "cs_123", status: "expired" })

    await expect(
      expireOpenStripeCheckoutSession({
        target: { kind: "connect", client, stripeAccount },
        sessionId: "cs_123",
      })
    ).resolves.toBe("expired")
    expect(sessions.expire).toHaveBeenCalledWith(
      "cs_123",
      expect.objectContaining({ stripeAccount })
    )
  })

  it("refuses a connect target with no account before calling Stripe", async () => {
    const { client, sessions } = connectClient()
    await expect(
      createStripeInvoiceCheckoutSession({
        target: { kind: "connect", client, stripeAccount: "  " },
        invoice,
        amountDue: 100,
        successUrl: "https://app.example/pay/ok",
        cancelUrl: "https://app.example/pay/cancel",
      })
    ).rejects.toThrow("connected account")
    expect(sessions.create).not.toHaveBeenCalled()
  })

  it("uses a runtime connect target ahead of BYOK", async () => {
    const { client } = connectClient()
    const connect = { kind: "connect" as const, client, stripeAccount }
    setRuntimeExtensions([
      { id: "defer", resolveStripeCheckoutTarget: () => null },
      { id: "stripe-connect", resolveStripeCheckoutTarget: async () => connect },
    ])

    await expect(resolveStripeCheckoutTarget({ organizationId: "org_1" }, { connectReady: true })).resolves.toBe(connect)
  })

})
