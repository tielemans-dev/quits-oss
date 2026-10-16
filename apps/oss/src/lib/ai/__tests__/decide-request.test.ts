import { afterEach, describe, expect, it, vi } from "vitest"

import { decideRequest } from "../decide-request"

const answer = (intent: string, customer: string) => ({
  answers: {
    intent: { type: "choice", choice: intent, probabilities: { [intent]: 0.95 } },
    customer: { type: "choice", choice: customer, probabilities: { [customer]: 0.7 } },
  },
})

afterEach(() => vi.unstubAllGlobals())

describe("decideRequest", () => {
  it("asks for one request kind and one of the organization's customers, and reads both back", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(answer("creditNote", "Birk Arkitekter"))))
    vi.stubGlobal("fetch", fetch)

    const decision = await decideRequest({ apiKey: "key", text: "annuller fakturaen til birk", customers: ["Birk Arkitekter", "Studio Vester"] })

    expect(decision).toEqual({ kind: "creditNote", probability: 0.95, customer: { name: "Birk Arkitekter", probability: 0.7 } })
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.state).toBe("annuller fakturaen til birk")
    expect(Object.keys(body.questions.customer.criteria)).toEqual(["Birk Arkitekter", "Studio Vester", "none"])
  })

  it("drops a customer that is not the organization's and a kind it did not offer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(answer("invoice", "Somebody Else")))))
    expect((await decideRequest({ apiKey: "key", text: "faktura til nogen", customers: ["Birk Arkitekter"] }))?.customer).toBeNull()

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(answer("delete everything", "none")))))
    expect(await decideRequest({ apiKey: "key", text: "slet alt", customers: [] })).toBeNull()
  })

  it("leaves ordinary search on an upstream error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })))
    expect(await decideRequest({ apiKey: "key", text: "hvem skylder mig penge", customers: [] })).toBeNull()
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    expect(await decideRequest({ apiKey: "key", text: "hvem skylder mig penge", customers: [] })).toBeNull()
  })
})
