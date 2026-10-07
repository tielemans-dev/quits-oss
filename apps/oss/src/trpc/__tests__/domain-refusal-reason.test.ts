import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import superjson, { type SuperJSONResult } from "superjson"
import { describe, expect, it } from "vitest"
import { protectedProcedure, router } from "../init"
import { rethrowDomainError, unwrapOutcome } from "../outcome"

/** Served like `/api/trpc`, so the error shape is the one browsers and the compat harness see. */
const testRouter = router({
  refused: protectedProcedure.query(() =>
    unwrapOutcome({
      status: "failed",
      commandId: "cmd_1",
      error: { tag: "InvalidState", code: "renderer_unavailable", message: "Document renderer and artifact store required" },
    } as never)
  ),
  tagged: protectedProcedure.query(() => rethrowDomainError({ _tag: "InvalidState", code: "not_draft", message: "Only drafts" })),
  untagged: protectedProcedure.query(() => unwrapOutcome({ status: "failed", commandId: "cmd_2", error: { tag: "NotFound", message: "Missing" } } as never)),
})

async function call(path: string) {
  const response = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req: new Request(`http://localhost/api/trpc/${path}`),
    router: testRouter,
    createContext: async () => ({ session: { user: { id: "u_1" }, session: { activeOrganizationId: "org_a" } }, requestedOrganizationId: null }) as never,
  })
  const body = (await response.json()) as { error?: SuperJSONResult }
  return superjson.deserialize(body.error!) as { message: string; data: Record<string, unknown> }
}

describe("domain refusal codes over tRPC", () => {
  it("exposes the command error code as data.reason", async () => {
    const error = await call("refused")
    expect(error.message).toBe("Document renderer and artifact store required")
    expect(error.data).toMatchObject({ code: "BAD_REQUEST", reason: "renderer_unavailable" })
  })

  it("carries codes from rethrown tagged domain errors", async () => {
    expect((await call("tagged")).data).toMatchObject({ code: "BAD_REQUEST", reason: "not_draft" })
  })

  it("reports null when the refusal has no code", async () => {
    expect((await call("untagged")).data).toMatchObject({ code: "NOT_FOUND", reason: null })
  })
})
