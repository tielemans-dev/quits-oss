// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const list = vi.fn()
vi.mock("../../../trpc/client", () => ({ trpc: { jobs: { list: { query: () => list() } } } }))

import { getRequestOrganizationId } from "../../../lib/active-organization"
import { subscribeQueryRefresh } from "../../../lib/query-refresh"

import { useReminderJobs } from "../reminder-jobs-store"

const job = (steps: string[]) => [{ id: "job-1", status: "running", createdAt: new Date(), steps: steps.map((status, index) => ({ id: `s${index}`, label: "", labelParams: {}, invoiceId: `inv-${index}`, status })) }]

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  list.mockReset()
})

describe("useReminderJobs", () => {
  it("polls while a job runs and stops once it is done", async () => {
    list.mockResolvedValueOnce(job(["running"])).mockResolvedValueOnce(job(["running"])).mockResolvedValue(job(["succeeded"]))
    const { result } = renderHook(() => useReminderJobs())
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(result.current[0]!.steps[0]!.status).toBe("succeeded")
    const reads = list.mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(list.mock.calls.length).toBe(reads)
  })

  it("refreshes invoice readers when steps settle before the parent job status changes", async () => {
    const refresh = vi.fn()
    const unsubscribe = subscribeQueryRefresh(["invoices"], getRequestOrganizationId(), refresh)
    list.mockResolvedValueOnce(job(["running"])).mockResolvedValue(job(["succeeded"]))
    renderHook(() => useReminderJobs())
    await act(() => vi.advanceTimersByTimeAsync(0))
    refresh.mockClear()
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(refresh).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("keeps its subscription across re-renders, so a render cannot cut the polling chain", async () => {
    list.mockResolvedValue(job(["running"]))
    const { rerender } = renderHook(() => useReminderJobs())
    await act(() => vi.advanceTimersByTimeAsync(0))
    for (let i = 0; i < 3; i++) rerender()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(list).toHaveBeenCalledTimes(1)
  })
})
