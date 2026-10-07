import "dotenv/config"
import { describe, expect, it } from "vitest"
import { Route } from "../api/payments/stripe-webhook"

const handlers = Route.options.server?.handlers as {
  POST: (context: { request: Request }) => Promise<Response>
}

describe("stripe webhook route", () => {
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
