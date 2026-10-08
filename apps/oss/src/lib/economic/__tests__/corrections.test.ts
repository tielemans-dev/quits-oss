import { afterEach, describe, expect, it, vi } from "vitest"
import { EconomicClient, parseExactJson } from "../client"
import { canonical, normalize } from "../shapes"
import { extract } from "../extraction"
import { customer, fixtureResponse } from "./fixtures"

const credentials = { appSecret: "synthetic-app", grantToken: "synthetic-grant" }
afterEach(() => vi.useRealTimers())
describe("connector review regressions", () => {
  it("refuses a future HTTP-date Retry-After beyond the delay cap", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 429, headers: { "retry-after": new Date(Date.now() + 3_600_000).toUTCString() } }))
    await expect(new EconomicClient(credentials, { fetch: transport }).json("rest", "self")).rejects.toMatchObject({ code: "limit_exceeded" })
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it("honors a short HTTP-date and admits each retry separately", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-08T00:00:00Z"))
    const admissions: number[] = []
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "Thu, 08 Oct 2026 00:00:01 GMT" } })).mockResolvedValueOnce(Response.json({ ok: true }))
    const result = new EconomicClient(credentials, { fetch: transport, fence: async read => { admissions.push(Date.now()); return read() } }).json("rest", "self")
    await vi.advanceTimersByTimeAsync(999)
    expect(transport).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ ok: true })
    expect(admissions).toEqual([Date.parse("2026-10-08T00:00:00Z"), Date.parse("2026-10-08T00:00:01Z")])
  })
  it("distinguishes JSON numbers, strings, objects and arrays including tag lookalikes", () => {
    const values = ['1', '"1"', '{"lexeme":"1"}', '["number","1"]', '{"type":"number","value":"1"}', 'null', 'false'].map(value => normalize("customer", parseExactJson(`{"customerNumber":7,"name":"Synthetic","extension":${value}}`), "DKK"))
    expect(new Set(values.map(row => row.sourceHash)).size).toBe(values.length)
    expect(canonical(parseExactJson('{"a":1.00,"b":{"lexeme":"1.00"}}'))).toBe(canonical(parseExactJson('{"b":{"lexeme":"1.00"},"a":1.00}')))
  })
  it("stops extraction when an additional numeric field becomes a lexeme object", async () => {
    let reads = 0
    const transport = (async input => {
      const url = new URL(String(input))
      return url.pathname === "/customers" ? Response.json({ collection: [{ ...customer, extension: ++reads === 1 ? 1 : { lexeme: "1" } }], pagination: { results: 1 } }) : fixtureResponse(url)
    }) as typeof fetch
    await expect(extract(new EconomicClient(credentials, { fetch: transport }), "123")).rejects.toMatchObject({ code: "source_drift" })
  })
})
