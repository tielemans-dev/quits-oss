import { beforeEach, describe, expect, it, vi } from "vitest"

const stripeApi = vi.hoisted(() => {
  class StripeInvalidRequestError extends Error {
    constructor(readonly code?: string) {
      super(code ?? "invalid request")
    }
  }
  return {
    StripeInvalidRequestError,
    expire: vi.fn(),
    retrieve: vi.fn(),
  }
})

vi.mock("stripe", () => {
  class Stripe {
    static errors = { StripeInvalidRequestError: stripeApi.StripeInvalidRequestError }
    checkout = { sessions: { expire: stripeApi.expire, retrieve: stripeApi.retrieve } }
  }
  return { default: Stripe }
})

import { expireOpenStripeCheckoutSession } from "../payments/stripe"

const input = { secretKey: "sk_test_123", sessionId: "cs_123" }

describe("expireOpenStripeCheckoutSession", () => {
  beforeEach(() => {
    stripeApi.expire.mockReset()
    stripeApi.retrieve.mockReset()
  })

  it("expires an open session", async () => {
    stripeApi.expire.mockResolvedValue({ id: "cs_123", status: "expired" })
    expect(await expireOpenStripeCheckoutSession(input)).toBe("expired")
    expect(stripeApi.expire).toHaveBeenCalledWith("cs_123")
  })

  it("leaves a session that is no longer open alone", async () => {
    stripeApi.expire.mockRejectedValue(new stripeApi.StripeInvalidRequestError())
    stripeApi.retrieve.mockResolvedValue({ id: "cs_123", status: "complete" })
    expect(await expireOpenStripeCheckoutSession(input)).toBe("not_open")
  })

  it("treats a session Stripe does not know as gone", async () => {
    stripeApi.expire.mockRejectedValue(new stripeApi.StripeInvalidRequestError("resource_missing"))
    expect(await expireOpenStripeCheckoutSession(input)).toBe("missing")
  })

  it("fails when an open session could not be expired, so the job retries", async () => {
    const refused = new stripeApi.StripeInvalidRequestError()
    stripeApi.expire.mockRejectedValue(refused)
    stripeApi.retrieve.mockResolvedValue({ id: "cs_123", status: "open" })
    await expect(expireOpenStripeCheckoutSession(input)).rejects.toBe(refused)
  })

  it("fails on outages", async () => {
    stripeApi.expire.mockRejectedValue(new Error("connection reset"))
    await expect(expireOpenStripeCheckoutSession(input)).rejects.toThrow("connection reset")
    expect(stripeApi.retrieve).not.toHaveBeenCalled()
  })
})
