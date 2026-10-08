// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  initializeRequestOrganizationId,
  resetRequestOrganizationForTesting,
} from "../../lib/active-organization"
import { createAppTrpcClient } from "../client"

/**
 * Answers every batched operation with `{ ok: true }`, recording each procedure that was sent.
 * Operations made in the same tick share one HTTP request, so the count is per operation.
 */
function countingFetch() {
  const sent: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost")
    const procedures = url.pathname.replace(/^\/api\/trpc\//, "").split(",")
    sent.push(...procedures)
    const body = procedures.map(() => ({ result: { data: { json: { ok: true } } } }))
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  })
  return { fetch: fetchMock as unknown as typeof fetch, fetchMock, sent }
}

afterEach(() => {
  resetRequestOrganizationForTesting()
})

describe("tRPC client query sharing", () => {
  it("sends one request for identical queries that are in flight together", async () => {
    const transport = countingFetch()
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })
    initializeRequestOrganizationId("org_a")

    const [first, second] = await Promise.all([client.settings.get.query(), client.settings.get.query()])

    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: true })
    expect(transport.sent).toEqual(["settings.get"])
  })

  it("sends a new request once the previous identical query has completed", async () => {
    const transport = countingFetch()
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })
    initializeRequestOrganizationId("org_a")

    await client.settings.get.query()
    await client.settings.get.query()

    expect(transport.sent).toEqual(["settings.get", "settings.get"])
  })

  it("does not share queries with different inputs or procedures", async () => {
    const transport = countingFetch()
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })
    initializeRequestOrganizationId("org_a")

    await Promise.all([
      client.quotes.get.query({ id: "q1" }),
      client.quotes.get.query({ id: "q2" }),
      client.settings.get.query(),
    ])

    expect(transport.sent).toHaveLength(3)
  })

  it("does not share a query between organizations", async () => {
    const transport = countingFetch()
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })

    initializeRequestOrganizationId("org_a")
    const pending = client.settings.get.query()
    resetRequestOrganizationForTesting()
    initializeRequestOrganizationId("org_b")
    await Promise.all([pending, client.settings.get.query()])

    expect(transport.sent).toHaveLength(2)
  })
})
