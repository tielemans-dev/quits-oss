// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  MIXED_ORGANIZATIONS,
  ORGANIZATION_HEADER,
  setRequestOrganizationId,
} from "../../lib/active-organization"
import { createAppTrpcClient } from "../client"

/** A fetch answering every batched operation, recording the organization header of each batch. */
function recordingFetch() {
  const headers: Array<string | null> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    headers.push(new Headers(init?.headers).get(ORGANIZATION_HEADER))
    const url = new URL(String(input), "http://localhost")
    const procedures = url.pathname.replace(/^\/api\/trpc\//, "").split(",")
    const body = procedures.map(() => ({ result: { data: { json: { ok: true } } } }))
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  })
  return { fetch: fetchMock as unknown as typeof fetch, fetchMock, headers }
}

afterEach(() => {
  setRequestOrganizationId(null)
})

describe("tRPC client organization header", () => {
  it("sends an operation for the organization active when it was made, even if switched before dispatch", async () => {
    const transport = recordingFetch()
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })

    setRequestOrganizationId("org_a")
    const pending = client.settings.get.query()
    // Switched in the same tick, before the batch is dispatched.
    setRequestOrganizationId("org_b")
    await pending

    expect(transport.fetchMock).toHaveBeenCalledTimes(1)
    expect(transport.headers).toEqual(["org_a"])
  })

  it("marks a batch mixing organizations so the server rejects it", async () => {
    const transport = recordingFetch()
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })

    setRequestOrganizationId("org_a")
    const first = client.settings.get.query()
    setRequestOrganizationId("org_b")
    const second = client.settings.get.query()
    await Promise.all([first, second])

    expect(transport.fetchMock).toHaveBeenCalledTimes(1)
    expect(transport.headers).toEqual([MIXED_ORGANIZATIONS])
  })

  it("sends no header while the organization is unknown", async () => {
    const transport = recordingFetch()
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })

    await client.settings.get.query()

    expect(transport.headers).toEqual([null])
  })
})
