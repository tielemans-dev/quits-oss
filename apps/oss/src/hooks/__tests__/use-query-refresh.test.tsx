// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useAppQuery } from "../use-query-refresh"
import { notifyMutation } from "../../lib/query-refresh"

afterEach(cleanup)
describe("shared query state", () => {
  it("does not query or refresh a closed reader, then loads when enabled", async () => {
    const query = vi.fn().mockResolvedValue([])
    const { rerender } = renderHook(({ open }) => useAppQuery(["contacts"], query, [], open), { initialProps: { open: false } })
    act(() => notifyMutation("contacts.update", null))
    expect(query).not.toHaveBeenCalled()
    rerender({ open: true })
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1))
  })
  it("refreshes mounted readers after a related mutation", async () => {
    const query = vi.fn().mockResolvedValue(["draft"])
    const { result, unmount } = renderHook(() => useAppQuery(["invoices"], query))
    await waitFor(() => expect(result.current.data).toEqual(["draft"]))
    query.mockResolvedValue(["sent"])
    act(() => notifyMutation("invoices.send", null))
    await waitFor(() => expect(result.current.data).toEqual(["sent"]))
    unmount()
    notifyMutation("invoices.send", null)
    expect(query).toHaveBeenCalledTimes(2)
  })
  it("distinguishes rejected queries from successful empty results and supports retry", async () => {
    const query = vi.fn().mockRejectedValue(new Error("Server unavailable"))
    const { result } = renderHook(() => useAppQuery(["quotes"], query))
    await waitFor(() => expect(result.current.error?.message).toBe("Server unavailable"))
    expect(result.current.data).toBeUndefined()
    query.mockResolvedValue([])
    await act(() => result.current.refresh())
    expect(result.current.data).toEqual([])
    expect(result.current.error).toBeNull()
  })
  it("drops late answers and late failures after a newer refresh", async () => {
    let reject!: (error: Error) => void
    const query = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockResolvedValue(["new"])
    const { result } = renderHook(() => useAppQuery(["invoices"], query))
    await act(() => result.current.refresh())
    await act(async () => reject(new Error("old")))
    expect(result.current.data).toEqual(["new"])
    expect(result.current.error).toBeNull()
  })
  it("reports failed background refreshes instead of silently keeping old figures", async () => {
    const query = vi.fn().mockResolvedValue([1])
    const { result } = renderHook(() => useAppQuery(["dashboard"], query))
    await waitFor(() => expect(result.current.data).toEqual([1]))
    query.mockRejectedValue(new Error("Refresh failed"))
    await act(() => result.current.refresh())
    expect(result.current.error?.message).toBe("Refresh failed")
  })
})
