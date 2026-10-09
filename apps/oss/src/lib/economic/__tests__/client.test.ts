import { describe, expect, it, vi } from "vitest"
import { EconomicClient, ExactNumber, parseExactJson } from "../client"

const credentials = { appSecret: "test-app-secret", grantToken: "test-grant-secret" }
const make = (fetcher: typeof fetch) => new EconomicClient(credentials, { fetch: fetcher })
describe("e-conomic read transport", () => {
  it("refuses cross-origin pagination before sending credentials", async () => {
    const transport = vi.fn<typeof fetch>()
    await expect(make(transport).json("rest", "https://attacker.test/customers")).rejects.toMatchObject({ code: "unsafe_link" })
    expect(transport).not.toHaveBeenCalled()
  })
  it("does not lose decimal precision while parsing provider JSON", () => {
    expect(parseExactJson('{"amount":9007199254740993.01,"name":"42"}')).toEqual({ amount: new ExactNumber("9007199254740993.01"), name: "42" })
  })
})

import { safeUrl } from "../client"
import { minor, sourceDateTime } from "../shapes"
import { extract, planWriteback, preflight } from "../extraction"
import { fixtureFetch, fixtureResponse, invoice } from "./fixtures"

describe("transport and extraction refusal boundaries", () => {
  it.each(["//evil.test/customers", "https://restapi.e-conomic.com.evil.test/customers", "http://restapi.e-conomic.com/customers", "https://user:pass@restapi.e-conomic.com/customers", "customers?token=secret", "customers?pagesize=2&pagesize=3", "customers#secret", "invoices/drafts", "https://apis.e-conomic.com/bookedEntriesapi/v7.0.0/booked-entries"])("rejects unsafe link %s", link => expect(() => safeUrl("rest", link)).toThrow())
  it("rejects redirects and sanitizes transport errors", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("test-grant-secret", { status: 302, headers: { location: "https://evil.test" } }))
    await expect(make(transport).json("rest", "self")).rejects.toMatchObject({ code: "unsafe_link" })
    expect(transport.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "manual" })
    transport.mockRejectedValue(new Error("test-app-secret test-grant-secret"))
    await expect(make(transport).json("rest", "self")).rejects.toThrow("e-conomic: provider_unavailable (rest)")
  })
  it.each([[401,"revoked"],[403,"missing_role"],[404,"not_found"],[400,"no_access"]] as const)("maps HTTP %s safely", async (status, code) => {
    await expect(make(vi.fn<typeof fetch>().mockResolvedValue(new Response("credential", { status }))).json("rest", "self")).rejects.toMatchObject({ code })
  })
  it("bounds rate retries and bytes", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 429, headers: { "retry-after": "0" } }))
    await expect(make(transport).json("rest", "self")).rejects.toMatchObject({ code: "provider_unavailable" })
    expect(transport).toHaveBeenCalledTimes(3)
    transport.mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "500" } }))
    await expect(make(transport).json("rest", "self")).rejects.toMatchObject({ code: "limit_exceeded" })
    await expect(new EconomicClient(credentials, { fetch: fixtureFetch, maxBytes: 3 }).json("rest", "self")).rejects.toMatchObject({ code: "limit_exceeded" })
  })
  it("normalizes exact money and refuses unknown precision", () => {
    expect(minor(parseExactJson("90071992547409.93"), "DKK")).toBe("9007199254740993")
    expect(minor(parseExactJson("-12.50"), "DKK")).toBe("-1250")
    for (const [amount, code] of [["12.001","DKK"],["12.00","XXX"],["12.00","KWD"]]) expect(() => minor(parseExactJson(amount!), code!)).toThrow()
  })
  it("reports missing bookkeeping access independently of sales", async () => {
    const result = await preflight(make((async input => String(input).includes("/count") ? new Response(null, { status: 403 }) : fixtureResponse(new URL(String(input)))) as typeof fetch), "123")
    expect(result.readable).toBe(false)
    expect(result.probes.filter(p => p.state === "missing_role").map(p => p.area)).toEqual(["bookkeeping", "bookkeeping"])
  })
  it("extracts inert history and bytes without claiming reconciliation", async () => {
    const result = await extract(make(fixtureFetch), "123")
    expect(result.manifest).toMatchObject({ origin: "historical_import", intent: "dry_run_only", writeback: false, reconciliation: "not_performed" })
    expect(result.manifest.records.find(r => r.kind === "invoice")?.data.grossAmount).toBe("12500")
    expect(result.artifacts).toHaveLength(2)
    expect(planWriteback).toThrow("writeback_disabled")
  })
  it("binds original links to the exact source record", async () => {
    const transport = (async input => new URL(String(input)).pathname === "/invoices/booked" ? Response.json({ collection: [{ ...invoice, pdf: { download: "/invoices/booked/11/pdf" } }], pagination: {} }) : fixtureResponse(new URL(String(input)))) as typeof fetch
    await expect(extract(make(transport), "123")).rejects.toMatchObject({ code: "unsafe_link" })
  })
  it.each(["count", "duplicate", "drift"] as const)("refuses partial extraction on %s", async mode => {
    let customers = 0
    const transport = (async input => {
      const url = new URL(String(input))
      if (mode === "count" && url.pathname.endsWith("booked-entries/count")) return Response.json(2)
      if (url.pathname === "/customers") {
        customers++
        return Response.json({ collection: mode === "duplicate" ? [{ customerNumber: 7, name: "A" }, { customerNumber: 7, name: "A" }] : [{ customerNumber: 7, name: mode === "drift" && customers > 1 ? "B" : "A" }], pagination: {} })
      }
      return fixtureResponse(url)
    }) as typeof fetch
    await expect(extract(make(transport), "123")).rejects.toMatchObject({ code: mode === "duplicate" ? "duplicate_identity" : "source_drift" })
  })
  it("reports missing originals but fails denied or failed downloads", async () => {
    for (const status of [404, 403, 502]) {
      const transport = (async input => String(input).endsWith("/pdf") ? new Response(null, { status }) : fixtureResponse(new URL(String(input)))) as typeof fetch
      if (status === 404) expect((await extract(make(transport), "123")).artifacts.every(a => a.state === "missing")).toBe(true)
      else await expect(extract(make(transport), "123")).rejects.toBeInstanceOf(Error)
    }
  })
  it.each(["customers?pagesize=1000&skippages=0", "customers?pagesize=1000&skippages=2", "accounting-years?pagesize=1000&skippages=1", "https://evil.test/customers"])("rejects pagination %s", async next => {
    const transport = (async input => new URL(String(input)).pathname === "/customers" ? Response.json({ collection: [{ customerNumber: 7, name: "A" }], pagination: { next } }) : fixtureResponse(new URL(String(input)))) as typeof fetch
    await expect(extract(make(transport), "123")).rejects.toBeInstanceOf(Error)
  })
})

describe("complete pagination and strict numeric source shapes", () => {
  it("reads REST next links and opaque cursors on both full passes", async () => {
    const transport = (async input => {
      const url = new URL(String(input))
      if (url.pathname === "/customers") return Response.json({ collection: [{ customerNumber: url.searchParams.get("skippages") === "1" ? 8 : 7, name: "Synthetic" }], pagination: url.searchParams.get("skippages") === "1" ? {} : { next: "/customers?pagesize=1000&skippages=1" } })
      if (url.pathname.endsWith("/booked-entries/count")) return Response.json(0)
      if (url.pathname.endsWith("/booked-entries")) return Response.json({ items: [] })
      if (url.pathname.endsWith("/AttachedDocuments/count")) return Response.json(2)
      if (url.pathname.endsWith("/AttachedDocuments")) return Response.json({ items: [{ number: url.searchParams.has("cursor") ? 6 : 5, accountingYear: "2026", voucherNumber: 10, pageCount: 1 }], ...(url.searchParams.has("cursor") ? {} : { cursor: "opaque+/=" }) })
      return fixtureResponse(url)
    }) as typeof fetch
    const result = await extract(make(transport), "123")
    expect(result.manifest.records.filter(r => r.kind === "customer").map(r => r.sourceId)).toEqual(["7", "8"])
    expect(result.artifacts.filter(a => a.kind === "attachment")).toHaveLength(2)
  })
  it.each(["125", null, true, {}, "1e2"])("refuses nonnumeric source amount %s", async amount => {
    const transport = (async input => new URL(String(input)).pathname === "/invoices/booked" ? Response.json({ collection: [{ ...invoice, grossAmount: amount }], pagination: {} }) : fixtureResponse(new URL(String(input)))) as typeof fetch
    await expect(extract(make(transport), "123")).rejects.toMatchObject({ code: "invalid_response" })
  })
  it("refuses cyclic cursors and malformed successful responses", async () => {
    const transport = (async input => String(input).includes("/booked-entries/matched-pairs") ? Response.json({ items: [], cursor: "again" }) : fixtureResponse(new URL(String(input)))) as typeof fetch
    await expect(extract(make(transport), "123")).rejects.toMatchObject({ code: "source_drift" })
    await expect(make(vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { headers: { "content-type": "text/html" } }))).json("rest", "self")).rejects.toMatchObject({ code: "invalid_response" })
    await expect(make(vi.fn<typeof fetch>().mockResolvedValue(new Response("not pdf", { headers: { "content-type": "application/pdf" } }))).pdf("rest", "invoices/booked/10/pdf")).rejects.toMatchObject({ code: "invalid_response" })
  })
  it("aborts a slow request and bounds total calls", async () => {
    const transport = ((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("secret must not escape"))))) as typeof fetch
    await expect(new EconomicClient(credentials, { fetch: transport, timeoutMs: 5 }).json("rest", "self")).rejects.toMatchObject({ code: "provider_unavailable" })
    const client = new EconomicClient(credentials, { fetch: fixtureFetch, maxCalls: 1 })
    await client.json("rest", "self")
    await expect(client.json("rest", "self")).rejects.toMatchObject({ code: "limit_exceeded" })
  })
})


describe("REST collection count controls", () => {
  it("refuses a missing next page when the supplied total proves records are missing", async () => {
    const transport = (async input => new URL(String(input)).pathname === "/customers" ? Response.json({ collection: [{ customerNumber: 7, name: "Synthetic" }], pagination: { results: 2 } }) : fixtureResponse(new URL(String(input)))) as typeof fetch
    await expect(extract(make(transport), "123")).rejects.toMatchObject({ code: "source_drift" })
  })
})

describe("foreign-currency source rounding", () => {
  it("keeps rounding in agreement base currency even for zero-exponent invoices", async () => {
    const transport = (async input => new URL(String(input)).pathname === "/invoices/booked" ? Response.json({ collection: [{ ...invoice, currency: "JPY", roundingAmount: 0.25 }], pagination: {} }) : fixtureResponse(new URL(String(input)))) as typeof fetch
    const result = await extract(make(transport), "123")
    expect(result.manifest.records.find(row => row.kind === "invoice")?.data).toMatchObject({ currency: "JPY", grossAmount: "125", roundingAmountInBaseCurrency: "25" })
  })
})


describe("documented nullable attachment metadata", () => {
  it("accepts null pageCount without inventing a page count", async () => {
    const transport = (async input => new URL(String(input)).pathname.endsWith("/AttachedDocuments") ? Response.json({ items: [{ number: 5, accountingYear: "2026", voucherNumber: 10, pageCount: null }] }) : fixtureResponse(new URL(String(input)))) as typeof fetch
    const result = await extract(make(transport), "123")
    expect(result.manifest.records.find(row => row.kind === "attachment")?.data.pageCount).toBeNull()
    expect(result.manifest.records.find(row => row.kind === "entry")?.data.date).toBe("2026-10-01T00:00:00")
  })
})


describe("documented cursor emptiness and source timestamps", () => {
  it("accepts explicit null cursor items when independent counts are zero", async () => {
    const transport = (async input => {
      const url = new URL(String(input))
      if (url.pathname.endsWith("/count")) return Response.json(0)
      if (url.hostname === "apis.e-conomic.com") return Response.json({ items: null, cursor: null })
      return fixtureResponse(url)
    }) as typeof fetch
    const result = await extract(make(transport), "123")
    expect(result.manifest.records.filter(row => ["entry", "pair", "attachment"].includes(row.kind))).toEqual([])
  })
  it("preserves source date-times without inventing a timezone and refuses invalid dates", () => {
    for (const valid of ["2026-10-01T00:00:00", "2026-10-01T12:34:56.1234567Z", "2026-10-01T00:00:00+02:00"]) expect(sourceDateTime(valid)).toBe(valid)
    for (const invalid of ["2026-02-31T00:00:00", "2026-10-01T24:00:00", "2026-10-01T00:00:00+14:01", "2026-10-01"]) expect(() => sourceDateTime(invalid)).toThrow()
  })
})
