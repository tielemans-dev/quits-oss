import { afterEach, expect, it, vi } from "vitest"
import type { Context } from "../../init"
import { cvrRouter } from "../cvr"

const lookup = vi.hoisted(() => vi.fn(async (_value: string, context: { signal: AbortSignal }) => {
  context.signal.throwIfAborted()
  return new Promise<never>((_resolve, reject) => {
    context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })
  })
}))
vi.mock("../../../lib/distribution", () => ({ isCloudDistribution: true }))
vi.mock("../../../lib/runtime/extensions", () => ({ getRuntimeCapabilities: () => ({ onboardingV2: { enabled: true } }) }))
vi.mock("../../../lib/runtime/services", () => ({
  getCvrLookupProvider: () => ({ search: lookup, get: lookup, suggestions: lookup }),
}))
vi.mock("../../init", async () => {
  const { initTRPC } = await import("@trpc/server")
  const t = initTRPC.context<Context>().create()
  const procedure = t.procedure.use(({ next }) => next({ ctx: { user: { id: "user" }, organizationId: "org" } }))
  return { router: t.router, authorizedProcedure: () => procedure, protectedProcedure: procedure }
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); lookup.mockClear() })

it.each(["search", "get", "suggestions", "customer"] as const)("cancels CVR %s on request and procedure cancellation and timeout", async method => {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms)
    return controller.signal
  })
  for (const source of ["request", "procedure", "timeout", "already-aborted"] as const) {
    const request = new AbortController(), procedure = new AbortController()
    if (source === "already-aborted") request.abort()
    const caller = cvrRouter.createCaller({ session: null, request: {
      url: "http://localhost", headers: new Headers(), signal: request.signal,
    } }, { signal: procedure.signal })
    const calls = lookup.mock.calls.length
    const result = method === "search" ? caller.search({ q: "Nordlys" }) : caller[method]({ cvr: "12345678" })
    const rejected = expect(result).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    if (source === "request") request.abort()
    if (source === "procedure") procedure.abort()
    if (source === "timeout") await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    if (source === "already-aborted") expect(lookup).toHaveBeenCalledTimes(calls)
    else expect(lookup.mock.lastCall?.[1].signal.aborted).toBe(true)
  }
})
