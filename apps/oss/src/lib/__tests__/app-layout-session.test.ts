// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  APP_LAYOUT_SESSION_REUSE_MS,
  invalidateAppLayoutSession,
  invalidateAppLayoutSessionUnlessUser,
  reuseAppLayoutSession,
  seedAppLayoutSession,
} from "../app-layout-session"

type Answer = { user: unknown; n: number }

function loader(user: unknown = { id: "u_1" }) {
  let calls = 0
  const load = vi.fn(async (): Promise<Answer> => ({ user, n: ++calls }))
  return load
}

afterEach(() => {
  invalidateAppLayoutSession()
  vi.unstubAllEnvs()
})

describe("app layout session reuse window", () => {
  it("is a few seconds", () => {
    expect(APP_LAYOUT_SESSION_REUSE_MS).toBeGreaterThanOrEqual(3_000)
    expect(APP_LAYOUT_SESSION_REUSE_MS).toBeLessThanOrEqual(10_000)
  })

  it("serves navigations and preloads inside the window from one server call", async () => {
    const load = loader()
    let clock = 1_000
    const now = () => clock

    const first = await reuseAppLayoutSession(load, now)
    clock += APP_LAYOUT_SESSION_REUSE_MS - 1
    const second = await reuseAppLayoutSession(load, now)

    expect(load).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it("asks the server again once the window has passed", async () => {
    const load = loader()
    let clock = 1_000
    const now = () => clock

    await reuseAppLayoutSession(load, now)
    clock += APP_LAYOUT_SESSION_REUSE_MS
    const again = await reuseAppLayoutSession(load, now)

    expect(load).toHaveBeenCalledTimes(2)
    expect(again.n).toBe(2)
  })

  it("shares one request between a hover preload and the click that follows", async () => {
    let resolve: (value: Answer) => void = () => undefined
    const load = vi.fn(() => new Promise<Answer>((r) => (resolve = r)))

    const preload = reuseAppLayoutSession(load)
    const navigation = reuseAppLayoutSession(load)
    resolve({ user: { id: "u_1" }, n: 1 })

    expect(load).toHaveBeenCalledTimes(1)
    expect(await navigation).toBe(await preload)
  })

  it("forgets the answer when invalidated, so the next navigation asks the server", async () => {
    const load = loader()
    await reuseAppLayoutSession(load)
    invalidateAppLayoutSession()
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("does not keep an answer that was still loading when it was invalidated", async () => {
    let resolve: (value: Answer) => void = () => undefined
    const slow = vi.fn(() => new Promise<Answer>((r) => (resolve = r)))
    const pending = reuseAppLayoutSession(slow)

    invalidateAppLayoutSession()
    resolve({ user: { id: "old" }, n: 1 })
    await pending

    const fresh = loader({ id: "new" })
    expect((await reuseAppLayoutSession(fresh)).user).toEqual({ id: "new" })
    expect(fresh).toHaveBeenCalledTimes(1)
  })

  it("never reuses a signed-out answer", async () => {
    const load = loader(null)
    await reuseAppLayoutSession(load)
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("does not remember a failed load", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ user: { id: "u_1" } })
    await expect(reuseAppLayoutSession(load)).rejects.toThrow("offline")
    await expect(reuseAppLayoutSession(load)).resolves.toEqual({ user: { id: "u_1" } })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("never caches in the server build, where the module is shared between users", async () => {
    // The guard is the build-time `import.meta.env.SSR`, not a run-time look at `window`: a jsdom
    // test has a `window`, and the server bundle must still not cache.
    vi.stubEnv("SSR", true)
    expect(typeof window).toBe("object")
    const load = loader({ id: "u_1" })

    await reuseAppLayoutSession(load)
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(2)

    // Nothing was kept for the next request, even once the build says browser again.
    vi.stubEnv("SSR", false)
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it("cannot be seeded on the server either", async () => {
    vi.stubEnv("SSR", true)
    seedAppLayoutSession({ user: { id: "u_1" } })
    vi.stubEnv("SSR", false)
    const load = loader()
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe("seeding from the server-rendered answer", () => {
  it("serves the first navigation without asking the server", async () => {
    seedAppLayoutSession({ user: { id: "u_1" }, n: 0 })
    const load = loader()
    expect((await reuseAppLayoutSession(load)).n).toBe(0)
    expect(load).not.toHaveBeenCalled()
  })

  it("does not replace an answer the browser already holds, nor keep a signed-out one", async () => {
    const load = loader({ id: "u_2" })
    await reuseAppLayoutSession(load)
    seedAppLayoutSession({ user: { id: "u_1" }, n: 0 })
    expect((await reuseAppLayoutSession(load)).user).toEqual({ id: "u_2" })

    invalidateAppLayoutSession()
    seedAppLayoutSession({ user: null, n: 0 })
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe("the cached answer belongs to one user", () => {
  it("is dropped when the live session names another user, or none", async () => {
    const load = loader({ id: "u_1" })
    await reuseAppLayoutSession(load)

    invalidateAppLayoutSessionUnlessUser("u_1")
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(1)

    invalidateAppLayoutSessionUnlessUser("u_2")
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(2)

    invalidateAppLayoutSessionUnlessUser(null)
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it("is dropped when the seeded user differs from the live session", async () => {
    seedAppLayoutSession({ user: { id: "u_1" } })
    invalidateAppLayoutSessionUnlessUser("u_2")
    const load = loader({ id: "u_2" })
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
