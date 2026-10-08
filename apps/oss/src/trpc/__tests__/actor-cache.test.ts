import { beforeEach, describe, expect, it, vi } from "vitest"
import { resolveUserActor } from "../../domain/user-actor"
import { orgProcedure, router } from "../init"

vi.mock("../../domain/user-actor", () => ({
  resolveUserActor: vi.fn(async (input: { organizationId: string; userId: string }) => ({
    kind: "user",
    organizationId: input.organizationId,
    userId: input.userId,
    roles: ["admin"],
    label: "Test user",
  })),
}))

const lookup = vi.mocked(resolveUserActor)

const testRouter = router({ whoami: orgProcedure.query(({ ctx }) => ctx.actor.userId) })

function context(actorCache?: Map<string, unknown>) {
  return {
    session: {
      user: { id: "u_1", name: "Ada", email: "ada@example.com" },
      session: { activeOrganizationId: "org_a" },
    },
    requestedOrganizationId: null,
    actorCache: actorCache as never,
  }
}

describe("per-request actor cache", () => {
  beforeEach(() => {
    lookup.mockClear()
  })

  it("resolves the membership once for every procedure of one request", async () => {
    const ctx = context(new Map())
    const caller = testRouter.createCaller(ctx as never)

    await expect(Promise.all([caller.whoami(), caller.whoami()])).resolves.toEqual(["u_1", "u_1"])
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it("does not reuse a membership across requests", async () => {
    await testRouter.createCaller(context(new Map()) as never).whoami()
    await testRouter.createCaller(context(new Map()) as never).whoami()
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it("looks up every time when a context has no cache", async () => {
    const caller = testRouter.createCaller(context() as never)
    await caller.whoami()
    await caller.whoami()
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it("retries a failed lookup instead of caching the failure", async () => {
    lookup.mockRejectedValueOnce(new Error("database unavailable"))
    const caller = testRouter.createCaller(context(new Map()) as never)

    await expect(caller.whoami()).rejects.toThrow("database unavailable")
    await expect(caller.whoami()).resolves.toBe("u_1")
    expect(lookup).toHaveBeenCalledTimes(2)
  })
})
