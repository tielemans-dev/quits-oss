import "dotenv/config"
import { beforeEach, describe, expect, it, vi } from "vitest"

const isOperationsHeld = vi.hoisted(() => vi.fn())
vi.mock("../../lib/operations-hold", () => ({ isOperationsHeld }))

import { Route } from "../api/payments/stripe-webhook"

const handlers = Route.options.server?.handlers as {
  POST: (context: { request: Request }) => Promise<Response>
}

describe("stripe webhook route", () => {
  beforeEach(() => {
    isOperationsHeld.mockReset().mockResolvedValue(false)
  })

  it("answers 503 while operations are held so Stripe retries instead of dropping the payment", async () => {
    isOperationsHeld.mockResolvedValue(true)
    const response = await handlers.POST({
      request: new Request("http://localhost/api/payments/stripe-webhook", {
        method: "POST",
        body: JSON.stringify({ type: "checkout.session.completed" }),
        headers: { "content-type": "application/json", "stripe-signature": "t=123,v1=anything" },
      }),
    } as never)

    expect(response.status).toBe(503)
  })

  it("rejects unsigned webhook requests", async () => {
    const response = await handlers.POST({
      request: new Request("http://localhost/api/payments/stripe-webhook", {
        method: "POST",
        body: JSON.stringify({ type: "checkout.session.completed" }),
        headers: {
          "content-type": "application/json",
        },
      }),
    } as never)

    expect(response.status).toBe(400)
  })

  it("rejects malformed or unverified signatures", async () => {
    const response = await handlers.POST({
      request: new Request("http://localhost/api/payments/stripe-webhook", {
        method: "POST",
        body: JSON.stringify({ type: "checkout.session.completed" }),
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=123,v1=bad",
        },
      }),
    } as never)

    expect(response.status).toBe(400)
  })
})
