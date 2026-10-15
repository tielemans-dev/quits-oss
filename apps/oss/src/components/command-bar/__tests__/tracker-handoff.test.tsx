// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { holdTracker } from "../../jobs/tracker-hold"
import { handOffToTracker } from "../tracker-handoff"

const labels = { failed: "Rykkerne blev ikke sat i gang.", retry: "Prøv igen", close: "Luk" }
const from = new DOMRect(100, 100, 400, 300)
const square = () => document.querySelector("[data-slot=tracker-handoff]")

afterEach(() => {
  cleanup()
  square()?.parentElement?.remove()
  document.querySelector("[data-slot=reminder-tracker]")?.remove()
})

function toast(jobId: string) {
  const el = document.createElement("section")
  el.dataset.slot = "reminder-tracker"
  el.dataset.jobId = jobId
  document.body.append(el)
}

describe("tracker hand-off", () => {
  it("shows the spinner square, starts the send once, and lets go when the toast of a new job takes over", async () => {
    const send = vi.fn().mockResolvedValue({ jobId: "j2" })
    toast("old")
    handOffToTracker(from, send, labels)

    await waitFor(() => expect(square()).not.toBeNull())
    expect(send).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(square()).not.toBeNull() // the old toast is not the one it waits for

    act(() => { document.querySelector("[data-slot=reminder-tracker]")!.remove(); toast("j2") })
    await waitFor(() => expect(square()).toBeNull())
  })

  it("lets go soon after the job was queued even if no toast comes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    handOffToTracker(from, vi.fn().mockResolvedValue({}), labels)

    await waitFor(() => expect(square()).not.toBeNull())
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    await waitFor(() => expect(square()).toBeNull())
    vi.useRealTimers()
  })

  it("says so on failure and retries the same send", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue({})
    handOffToTracker(from, send, labels)

    await screen.findByText(labels.failed)
    fireEvent.click(screen.getByRole("button", { name: "Prøv igen" }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(labels.failed)).toBeNull())
  })

  it("holds the tracker while it flies", async () => {
    const { renderHook } = await import("@testing-library/react")
    const { useTrackerHeld } = await import("../../jobs/tracker-hold")
    const { result } = renderHook(() => useTrackerHeld())
    expect(result.current).toBe(false)
    let release!: () => void
    act(() => { release = holdTracker() })
    expect(result.current).toBe(true)
    act(() => release())
    expect(result.current).toBe(false)
  })
})
