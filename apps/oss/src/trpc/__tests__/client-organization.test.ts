// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  initializeRequestOrganizationId,
  isOrganizationChanged,
  resetRequestOrganizationForTesting,
} from "../../lib/active-organization"
import {
  MIXED_ORGANIZATIONS,
  ORGANIZATION_CHANGED_MESSAGE,
  ORGANIZATION_CHANGED_REASON,
  ORGANIZATION_HEADER,
  organizationRequestHeaders,
} from "../../lib/organization-request"
import { createAppTrpcClient } from "../client"

type Answer = { result: { data: { json: unknown } } } | { error: { json: unknown } }

/** A fetch answering every batched operation, recording the organization header of each batch. */
function recordingFetch(answer: () => Answer = () => ({ result: { data: { json: { ok: true } } } })) {
  const headers: Array<string | null> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    headers.push(new Headers(init?.headers).get(ORGANIZATION_HEADER))
    const url = new URL(String(input), "http://localhost")
    const procedures = url.pathname.replace(/^\/api\/trpc\//, "").split(",")
    const body = procedures.map(() => answer())
    const status = body.some((item) => "error" in item) ? 409 : 200
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  })
  return { fetch: fetchMock as unknown as typeof fetch, fetchMock, headers }
}

function conflict(reason: string | null): Answer {
  return {
    error: {
      json: {
        message: reason ? ORGANIZATION_CHANGED_MESSAGE : "This action is waiting for approval",
        code: -32009,
        data: { code: "CONFLICT", httpStatus: 409, path: "settings.get", reason },
      },
    },
  }
}

/** Simulates a new page load acting for `organizationId` (the store has a single writer). */
function newPageLoad(organizationId: string) {
  resetRequestOrganizationForTesting()
  initializeRequestOrganizationId(organizationId)
}

afterEach(() => {
  resetRequestOrganizationForTesting()
})

describe("tRPC client organization header", () => {
  it("sends the organization this tab acts for", async () => {
    const transport = recordingFetch()
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })

    initializeRequestOrganizationId("org_a")
    await client.settings.get.query()

    expect(transport.headers).toEqual(["org_a"])
  })

  it("sends an operation for the organization it was made for, even if that changes before dispatch", async () => {
    const transport = recordingFetch()
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })

    newPageLoad("org_a")
    const pending = client.settings.get.query()
    // Changed in the same tick, before the batch is dispatched.
    newPageLoad("org_b")
    await pending

    expect(transport.fetchMock).toHaveBeenCalledTimes(1)
    expect(transport.headers).toEqual(["org_a"])
  })

  it("marks a batch mixing organizations so the server rejects it", async () => {
    const transport = recordingFetch()
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })

    newPageLoad("org_a")
    const first = client.settings.get.query()
    newPageLoad("org_b")
    const second = client.settings.get.query()
    await Promise.all([first, second])

    expect(transport.fetchMock).toHaveBeenCalledTimes(1)
    expect(transport.headers).toEqual([MIXED_ORGANIZATIONS])
  })

  it("sends no header before the organization is initialized", async () => {
    const transport = recordingFetch()
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })

    await client.settings.get.query()

    expect(transport.headers).toEqual([null])
  })

  it("builds headers for known, unknown and mixed organizations", () => {
    expect(organizationRequestHeaders([null])).toEqual({})
    expect(organizationRequestHeaders(["org_a", null, "org_a"])).toEqual({ [ORGANIZATION_HEADER]: "org_a" })
    expect(organizationRequestHeaders(["org_a", "org_b"])).toEqual({ [ORGANIZATION_HEADER]: MIXED_ORGANIZATIONS })
  })
})

describe("tRPC client organization changed detection", () => {
  it("records that the organization changed when the server's organization check rejects a request", async () => {
    const transport = recordingFetch(() => conflict(ORGANIZATION_CHANGED_REASON))
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })
    initializeRequestOrganizationId("org_a")

    await expect(client.settings.get.query()).rejects.toMatchObject({ data: { code: "CONFLICT" } })
    expect(isOrganizationChanged()).toBe(true)
  })

  it("ignores every other CONFLICT", async () => {
    const transport = recordingFetch(() => conflict(null))
    const client = createAppTrpcClient({ url: "http://localhost/api/trpc", fetch: transport.fetch })
    initializeRequestOrganizationId("org_a")

    await expect(client.settings.get.query()).rejects.toMatchObject({ data: { code: "CONFLICT" } })
    expect(isOrganizationChanged()).toBe(false)
  })
})
