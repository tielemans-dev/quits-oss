// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  APP_LAYOUT_SESSION_REUSE_MS,
  invalidateAppLayoutSession,
  reuseAppLayoutSession,
} from "../app-layout-session"

type Answer = { session: unknown; n: number }

function loader(session: unknown = { user: "u_1" }) {
  let calls = 0
  const load = vi.fn(async (): Promise<Answer> => ({ session, n: ++calls }))
  return load
}

afterEach(() => {
  invalidateAppLayoutSession()
  vi.unstubAllGlobals()
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
    resolve({ session: { user: "u_1" }, n: 1 })

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
    resolve({ session: { user: "old" }, n: 1 })
    await pending

    const fresh = loader({ user: "new" })
    expect((await reuseAppLayoutSession(fresh)).session).toEqual({ user: "new" })
    expect(fresh).toHaveBeenCalledTimes(1)
  })

  it("never reuses a signed-out answer", async () => {
    const load = loader(null)
    await reuseAppLayoutSession(load)
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("does not remember a failed load", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ session: { user: "u_1" } })
    await expect(reuseAppLayoutSession(load)).rejects.toThrow("offline")
    await expect(reuseAppLayoutSession(load)).resolves.toEqual({ session: { user: "u_1" } })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("never caches on the server, where the module is shared between users", async () => {
    vi.stubGlobal("window", undefined)
    const load = loader()
    await reuseAppLayoutSession(load)
    await reuseAppLayoutSession(load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
