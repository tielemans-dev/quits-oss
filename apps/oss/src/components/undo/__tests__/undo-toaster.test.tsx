// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ held: vi.fn(), cancel: vi.fn(), hold: vi.fn(), release: vi.fn(), refresh: vi.fn() }))
vi.mock("../../../trpc/client", () => ({
  trpc: { jobs: {
    held: { query: api.held }, cancelHeld: { mutate: api.cancel }, holdHeld: { mutate: api.hold }, release: { mutate: api.release },
  } },
}))
vi.mock("../../jobs/reminder-jobs-store", () => ({ refreshReminderJobs: api.refresh }))

import { I18nProvider } from "../../../lib/i18n/react"
import { UNDO_HOLD_LEASE_MS, UNDO_WINDOW_MS } from "../../../lib/undo-window"
import { onRequestDone } from "../../command-bar/request-events"
import { addUndo, removeUndo, showUndo, useUndoItems } from "../undo-store"
import { UndoToaster } from "../undo-toaster"

function Harness() {
  return <I18nProvider locale="da-DK"><UndoToaster /></I18nProvider>
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  vi.useFakeTimers()
  api.held.mockResolvedValue([])
  api.cancel.mockResolvedValue({})
  api.hold.mockResolvedValue({})
  api.release.mockResolvedValue({ status: "done", error: null })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
  const Leftover = () => { for (const item of useUndoItems()) removeUndo(item.id); return null }
  render(<Leftover />)
  cleanup()
})

describe("undo toast", () => {
  it("counts down about eight seconds, and Fortryd reverses the action", async () => {
    const undo = vi.fn().mockResolvedValue(undefined)
    render(<Harness />)
    act(() => showUndo({ kind: "paid", undo }))

    expect(screen.getByText("Markeret som betalt")).toBeTruthy()
    expect(screen.getByText("8 s")).toBeTruthy()
    await tick(3000)
    expect(screen.getByText("5 s")).toBeTruthy()

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fortryd" })) })
    expect(undo).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Fortrudt")).toBeTruthy()
    await tick(UNDO_WINDOW_MS)
    expect(screen.queryByRole("button", { name: "Fortryd" })).toBeNull()
  })

  it("says so when it is too late, and keeps the action", async () => {
    render(<Harness />)
    act(() => showUndo({ kind: "paid", undo: vi.fn().mockRejectedValue(new Error("expired")) }))

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fortryd" })) })

    expect(screen.getByRole("alert").textContent).toBe("Det er for sent at fortryde")
  })

  it("pauses while hovered or focused, keeping a held send held, and resumes with the time that was left", async () => {
    const keepHeld = vi.fn().mockResolvedValue({})
    render(<Harness />)
    act(() => addUndo({ id: "j", kind: "reminders", count: 3, endsAt: Date.now() + UNDO_WINDOW_MS, undo: vi.fn(), keepHeld, elapsed: vi.fn() }))
    expect(screen.getByText("Sender rykker til 3")).toBeTruthy()
    await tick(2000)

    const toast = document.querySelector("[data-slot=undo-toast]")!
    fireEvent.pointerEnter(toast)
    await tick(5000)
    expect(screen.getByText("6 s")).toBeTruthy() // frozen
    expect(keepHeld).toHaveBeenCalledWith(expect.any(Number))
    expect(Math.max(...keepHeld.mock.calls.map(([ms]) => ms as number))).toBeLessThanOrEqual(UNDO_WINDOW_MS + UNDO_HOLD_LEASE_MS)
    expect(keepHeld.mock.calls.length).toBeGreaterThan(2) // renewed while paused

    keepHeld.mockClear()
    fireEvent.pointerLeave(toast)
    await tick(100)
    expect(keepHeld).toHaveBeenCalledTimes(1)
    expect(keepHeld.mock.calls[0]![0]).toBeLessThanOrEqual(6000)
    expect(keepHeld.mock.calls[0]![0]).toBeGreaterThan(5000)

    fireEvent.focus(screen.getByRole("button", { name: "Fortryd" }))
    await tick(4000)
    expect(screen.getByText("6 s")).toBeTruthy() // focus pauses too
  })

  it("releases a held send when its window closes and tells the page the invoice has gone out", async () => {
    const done = vi.fn()
    const off = onRequestDone(done)
    api.held.mockResolvedValue([{ id: "job-1", type: "invoice.delayed_send", steps: 0, heldForMs: 2000, invoiceId: "inv-1" }])
    render(<Harness />)
    await tick(0)
    expect(screen.getByText("Faktura sendes")).toBeTruthy() // found again after a reload

    await tick(1900)
    expect(api.release).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
    await tick(300)

    expect(api.release).toHaveBeenCalledWith({ jobId: "job-1" })
    expect(done).toHaveBeenCalledWith({ kind: "invoice", invoiceId: "inv-1" })
    expect(screen.getByText("Faktura sendt")).toBeTruthy()
    off()
  })

  it("says the invoice was not sent, and does not tell the page, when the send is refused", async () => {
    const done = vi.fn()
    const off = onRequestDone(done)
    api.held.mockResolvedValue([{ id: "job-2", type: "invoice.delayed_send", steps: 0, heldForMs: 500, invoiceId: "inv-2" }])
    api.release.mockResolvedValue({ status: "failed", error: "Recipient missing" })
    render(<Harness />)
    await tick(700)

    expect(screen.getByRole("alert").textContent).toBe("Fakturaen blev ikke sendt og ligger som kladde")
    expect(done).not.toHaveBeenCalled()
    off()
  })

  it("cancels a held send on the server with Fortryd", async () => {
    api.held.mockResolvedValue([{ id: "job-3", type: "reminders.batch", steps: 2, heldForMs: 6000, invoiceId: null }])
    render(<Harness />)
    await tick(0)

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fortryd" })) })

    expect(api.cancel).toHaveBeenCalledWith({ jobId: "job-3" })
    expect(api.release).not.toHaveBeenCalled()
    expect(api.refresh).toHaveBeenCalled()
  })

  it("drops the bar under reduced motion and keeps the seconds", () => {
    render(<Harness />)
    act(() => showUndo({ kind: "paid", undo: vi.fn() }))

    expect(document.querySelector("[data-slot=undo-toast] .motion-reduce\\:hidden")).not.toBeNull()
    expect(screen.getByText("8 s")).toBeTruthy()
  })
})
