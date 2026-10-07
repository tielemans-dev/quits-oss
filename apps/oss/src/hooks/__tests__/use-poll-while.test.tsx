// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { finalPollFailure, usePollWhile } from "../use-poll-while"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe("usePollWhile", () => {
  it("polls with backoff up to the maximum delay while active", async () => {
    const poll = vi.fn().mockResolvedValue(undefined)
    renderHook(() => usePollWhile(true, poll, { initialDelayMs: 1_000, maxDelayMs: 2_000, backoff: 2 }))

    await advance(999)
    expect(poll).toHaveBeenCalledTimes(0)
    await advance(1)
    expect(poll).toHaveBeenCalledTimes(1)
    // 1s * 2 = 2s, then capped at 2s.
    await advance(2_000)
    expect(poll).toHaveBeenCalledTimes(2)
    await advance(2_000)
    expect(poll).toHaveBeenCalledTimes(3)
  })

  it("stops once inactive and on unmount", async () => {
    const poll = vi.fn().mockResolvedValue(undefined)
    const { rerender, unmount } = renderHook(({ active }) => usePollWhile(active, poll, { initialDelayMs: 1_000 }), {
      initialProps: { active: true },
    })
    await advance(1_000)
    expect(poll).toHaveBeenCalledTimes(1)

    rerender({ active: false })
    await advance(60_000)
    expect(poll).toHaveBeenCalledTimes(1)

    rerender({ active: true })
    await advance(1_000)
    expect(poll).toHaveBeenCalledTimes(2)
    unmount()
    await advance(60_000)
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it("keeps polling after a failed poll", async () => {
    const poll = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined)
    renderHook(() => usePollWhile(true, poll, { initialDelayMs: 1_000, maxDelayMs: 1_000 }))

    await advance(2_000)
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it.each(["CONFLICT", "NOT_FOUND", "FORBIDDEN"])("stops polling and reports a %s failure", async (code) => {
    const error = Object.assign(new Error(`server says ${code}`), { data: { code } })
    const poll = vi.fn().mockRejectedValue(error)
    const { result } = renderHook(() => usePollWhile(true, poll, { initialDelayMs: 1_000, maxDelayMs: 1_000 }))

    await advance(1_000)
    expect(poll).toHaveBeenCalledTimes(1)
    expect(result.current).toEqual({ code, message: `server says ${code}` })

    await advance(60_000)
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it("clears a reported failure once polling is no longer wanted and polls again when wanted", async () => {
    const error = Object.assign(new Error("changed"), { data: { code: "CONFLICT" } })
    const poll = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined)
    const { result, rerender } = renderHook(({ active }) => usePollWhile(active, poll, { initialDelayMs: 1_000 }), {
      initialProps: { active: true },
    })
    await advance(1_000)
    expect(result.current?.code).toBe("CONFLICT")

    rerender({ active: false })
    expect(result.current).toBeNull()
    rerender({ active: true })
    await advance(1_000)
    expect(poll).toHaveBeenCalledTimes(2)
  })
})

describe("finalPollFailure", () => {
  it("treats other errors as transient", () => {
    expect(finalPollFailure(new Error("offline"))).toBeNull()
    expect(finalPollFailure(Object.assign(new Error("x"), { data: { code: "INTERNAL_SERVER_ERROR" } }))).toBeNull()
    expect(finalPollFailure(undefined)).toBeNull()
  })
})
