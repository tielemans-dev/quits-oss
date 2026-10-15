// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useCalendarDate } from "../use-calendar-date"

afterEach(() => { cleanup(); vi.useRealTimers() })

describe("useCalendarDate", () => {
  it.each([
    ["Europe/Copenhagen", "2026-10-11T21:59:59.999Z", "2026-10-11", "2026-10-12"],
    ["America/New_York", "2026-10-12T03:59:59.999Z", "2026-10-11", "2026-10-12"],
    ["Europe/Copenhagen", "2026-10-25T22:59:59.999Z", "2026-10-25", "2026-10-26"],
    ["invalid/zone", "2026-12-31T23:59:59.999Z", "2026-12-31", "2027-01-01"],
  ])("refreshes at midnight in %s", (timezone, instant, before, after) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(instant))
    const { result, unmount } = renderHook(() => useCalendarDate(timezone))
    expect(result.current).toBe(before)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(after)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reschedules across the 25-hour daylight-saving day", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-24T21:59:59.999Z"))
    const { result } = renderHook(() => useCalendarDate("Europe/Copenhagen"))
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe("2026-10-25")
    act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1000))
    expect(result.current).toBe("2026-10-25")
    act(() => vi.advanceTimersByTime(60 * 60 * 1000))
    expect(result.current).toBe("2026-10-26")
  })

  it.each(["focus", "visibilitychange"])("catches up after suspension on %s and responds to a timezone change", event => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-11T21:00:00Z"))
    const { result, rerender } = renderHook(({ timezone }) => useCalendarDate(timezone), { initialProps: { timezone: "Europe/Copenhagen" } })
    vi.setSystemTime(new Date("2026-10-11T23:00:00Z"))
    act(() => (event === "focus" ? window : document).dispatchEvent(new Event(event)))
    expect(result.current).toBe("2026-10-12")
    rerender({ timezone: "UTC" })
    expect(result.current).toBe("2026-10-11")
    expect(vi.getTimerCount()).toBe(1)
  })
})
