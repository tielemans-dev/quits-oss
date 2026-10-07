import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import superjson, { type SuperJSONResult } from "superjson"
import { describe, expect, it } from "vitest"
import {
  MIXED_ORGANIZATIONS,
  ORGANIZATION_CHANGED_MESSAGE,
  ORGANIZATION_CHANGED_REASON,
  OrganizationChangedError,
} from "../../lib/organization-request"
import { assertRequestedOrganization, protectedProcedure, router } from "../init"

function rejection(run: () => void) {
  try {
    run()
  } catch (error) {
    return error
  }
  return null
}

describe("requested organization check", () => {
  it("accepts a request for the active organization or naming none", () => {
    expect(() => assertRequestedOrganization("org_a", "org_a")).not.toThrow()
    expect(() => assertRequestedOrganization(null, "org_a")).not.toThrow()
    expect(() => assertRequestedOrganization(undefined, null)).not.toThrow()
  })

  it("rejects a request for another organization as an organization change", () => {
    const error = rejection(() => assertRequestedOrganization("org_b", "org_a"))
    expect(error).toMatchObject({ code: "CONFLICT", message: ORGANIZATION_CHANGED_MESSAGE })
    expect((error as Error).cause).toBeInstanceOf(OrganizationChangedError)
  })

  it("rejects the mixed sentinel whatever organization is active", () => {
    for (const active of ["org_a", MIXED_ORGANIZATIONS, null, undefined]) {
      expect(rejection(() => assertRequestedOrganization(MIXED_ORGANIZATIONS, active))).toMatchObject({
        code: "CONFLICT",
      })
    }
  })
})

/** A router served like `/api/trpc`, so the error shape is the one the browser receives. */
const testRouter = router({ ping: protectedProcedure.query(() => "pong") })

async function call(context: { session: unknown; requestedOrganizationId: string | null }) {
  const response = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req: new Request("http://localhost/api/trpc/ping"),
    router: testRouter,
    createContext: async () => context as never,
  })
  const body = (await response.json()) as { error?: SuperJSONResult }
  return body.error ? (superjson.deserialize(body.error) as { data: Record<string, unknown> }) : null
}

const session = { user: { id: "u_1" }, session: { activeOrganizationId: "org_a" } }

describe("organization changed error shape", () => {
  it("rejects a mixed batch even without an active organization or session", async () => {
    for (const ctx of [
      { session, requestedOrganizationId: MIXED_ORGANIZATIONS },
      { session: { ...session, session: { activeOrganizationId: null } }, requestedOrganizationId: MIXED_ORGANIZATIONS },
      { session: null, requestedOrganizationId: MIXED_ORGANIZATIONS },
    ]) {
      const error = await call(ctx)
      expect(error?.data).toMatchObject({ code: "CONFLICT", reason: ORGANIZATION_CHANGED_REASON })
    }
  })

  it("marks only the organization check's CONFLICT", async () => {
    expect(await call({ session, requestedOrganizationId: null })).toBeNull()
    const unauthorized = await call({ session: null, requestedOrganizationId: null })
    expect(unauthorized?.data).toMatchObject({ code: "UNAUTHORIZED", reason: null })
  })
})
