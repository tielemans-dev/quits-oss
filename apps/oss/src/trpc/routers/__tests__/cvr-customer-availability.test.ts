import { expect, it, vi } from "vitest"
import type { Context } from "../../init"
import { cvrRouter } from "../cvr"

const services = vi.hoisted(() => ({ provider: undefined as object | undefined }))
vi.mock("../../../lib/distribution", () => ({ isCloudDistribution: false }))
vi.mock("../../../lib/db", () => ({ prisma: {} }))
vi.mock("../../../lib/runtime/extensions", () => ({ getRuntimeCapabilities: () => ({}) }))
vi.mock("../../../lib/runtime/services", () => ({ getCvrLookupProvider: () => services.provider }))
vi.mock("../../init", async () => {
  const { initTRPC } = await import("@trpc/server")
  const t = initTRPC.context<Context>().create()
  const procedure = t.procedure.use(({ next }) => next({ ctx: { user: { id: "user" }, organizationId: "org" } }))
  return { router: t.router, authorizedProcedure: () => procedure, protectedProcedure: procedure }
})

it("offers the customer CVR lookup only where the runtime supplies a provider", async () => {
  const caller = cvrRouter.createCaller({ session: null })
  expect(await caller.customerAvailable()).toEqual({ enabled: false })
  services.provider = { search: vi.fn(), get: vi.fn() }
  expect(await caller.customerAvailable()).toEqual({ enabled: true })
})
