import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startDevScheduler } from "../dev-scheduler"

describe("development scheduler", () => {
  let stop: (() => void) | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("QUITS_DEV_SCHEDULER", "true")
    vi.stubEnv("VITEST", "")
    vi.stubEnv("PLAYWRIGHT_TEST", "")
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it.each([
    ["NODE_ENV", "production"],
    ["NODE_ENV", "test"],
    ["QUITS_DEV_SCHEDULER", "false"],
    ["QUITS_DEV_SCHEDULER", ""],
    ["VITEST", "true"],
    ["PLAYWRIGHT_TEST", "true"],
  ])("does not start with %s=%s", async (name, value) => {
    vi.stubEnv(name, value)
    const tick = vi.fn().mockResolvedValue(undefined)
    stop = startDevScheduler(tick)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tick).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("runs due work without overlapping ticks, and stops cleanly", async () => {
    let finish!: () => void
    const tick = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    stop = startDevScheduler(tick)
    expect(startDevScheduler(tick)).toBe(stop)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tick).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(tick).toHaveBeenCalledTimes(2)
    stop()
    finish()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tick).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps ticking after failure without logging exception text", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    const tick = vi.fn().mockRejectedValueOnce(new Error("private provider details")).mockResolvedValue(undefined)
    stop = startDevScheduler(tick)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(tick).toHaveBeenCalledTimes(2)
    expect(warning).toHaveBeenCalledExactlyOnceWith("[dev-scheduler] A tick failed; the scheduler will try again.")
    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(tick).toHaveBeenCalledTimes(2)
  })
})
