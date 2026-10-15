import { afterEach, expect, it, vi } from "vitest"
import { resetRuntimeServices, setRuntimeServices } from "../../../lib/runtime/services"
vi.mock("../../../lib/distribution", () => ({ isCloudDistribution: true }))
vi.mock("../../../lib/runtime/extensions", () => ({ getRuntimeCapabilities: () => ({ onboardingV2: { enabled: true } }) }))
vi.mock("../../init", async () => {
  const { initTRPC } = await import("@trpc/server")
  const t = initTRPC.context<{ user: { id: string }; organizationId: string; request: { signal: AbortSignal } }>().create()
  return { router: t.router, authorizedProcedure: () => t.procedure, protectedProcedure: t.procedure }
})
import { cvrRouter } from "../cvr"
afterEach(() => resetRuntimeServices())
it.each(["search", "get", "suggestions"] as const)("cancels an in-flight CVR %s when its request aborts", async operation => {
  const controller = new AbortController()
  const work = vi.fn((_query: string, { signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  }))
  setRuntimeServices({ cvrLookupProvider: { search: work, get: work, suggestions: work } })
  const caller = cvrRouter.createCaller({ user: { id: "user" }, organizationId: "org", request: { url: "http://localhost/api/trpc", headers: new Headers(), signal: controller.signal } } as never)
  const pending = caller[operation]({ q: "Nordlys", cvr: "24256790" })
  const rejected = expect(pending).rejects.toMatchObject({ message: "Cancelled stale lookup" })
  await vi.waitFor(() => expect(work).toHaveBeenCalledOnce())
  controller.abort(new Error("Cancelled stale lookup"))
  await rejected
  expect(work.mock.calls[0]![1].signal.aborted).toBe(true)
})
