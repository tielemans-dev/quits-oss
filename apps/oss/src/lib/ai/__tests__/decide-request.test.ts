import { afterEach, describe, expect, it, vi } from "vitest"

import { allowDecision, decideRequest } from "../decide-request"

const answer = (intent: string) => ({
  answers: { intent: { type: "choice", choice: intent, probabilities: { [intent]: 0.95 } } },
})

afterEach(() => vi.unstubAllGlobals())

describe("decideRequest", () => {
  it("sends only what was typed and reads back the request kind", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(answer("creditNote"))))
    vi.stubGlobal("fetch", fetch)

    const decision = await decideRequest({ apiKey: "key", text: "annuller fakturaen til birk" })

    expect(decision).toEqual({ kind: "creditNote", probability: 0.95 })
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.state).toBe("annuller fakturaen til birk")
    expect(Object.keys(body.questions)).toEqual(["intent"])
  })

  it("drops a kind it did not offer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(answer("delete everything")))))
    expect(await decideRequest({ apiKey: "key", text: "slet alt" })).toBeNull()
  })

  it("leaves ordinary search on an upstream error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })))
    expect(await decideRequest({ apiKey: "key", text: "hvem skylder mig penge" })).toBeNull()
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    expect(await decideRequest({ apiKey: "key", text: "hvem skylder mig penge" })).toBeNull()
  })
})

describe("allowDecision", () => {
  it("allows 300 calls a minute per organization", () => {
    const now = 1_000_000
    for (let call = 0; call < 300; call++) expect(allowDecision("org-limit", now)).toBe(true)
    expect(allowDecision("org-limit", now)).toBe(false)
    expect(allowDecision("org-other", now)).toBe(true)
    expect(allowDecision("org-limit", now + 60_000)).toBe(true)
  })
})
