import { afterEach, describe, expect, it, vi } from "vitest"
const api = vi.hoisted(() => ({ capabilities: vi.fn(), fill: vi.fn() }))
vi.mock("../../../trpc/client", () => ({ trpc: { runtime: { capabilities: { query: api.capabilities } }, ai: { fillRequest: { mutate: api.fill } } } }))
import { suggestRequest } from "../suggest-request"
const input = "Vil du lave en regning til Nordlys?"
const draft = { intent: "invoice", items: [], confidence: 0.5, remainder: "" }
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers() })

describe("request suggestion transport", () => {
  it("does not call the model endpoint while disabled or for known requests", async () => {
    api.capabilities.mockResolvedValue({ aiInvoiceDraft: { requestFallbackEnabled: false } })
    const signal = new AbortController().signal
    expect(await suggestRequest(input, () => true, signal)).toBeNull()
    expect(await suggestRequest("faktura til Nordlys", () => true, signal)).toBeNull()
    expect(api.fill).not.toHaveBeenCalled()
  })
  it("debounces a suggestion and uses a POST mutation so prompts stay out of URLs", async () => {
    vi.useFakeTimers()
    api.capabilities.mockResolvedValue({ aiInvoiceDraft: { requestFallbackEnabled: true } })
    api.fill.mockResolvedValue(draft)
    const signal = new AbortController().signal
    const result = suggestRequest(input, () => true, signal)
    await vi.advanceTimersByTimeAsync(599)
    expect(api.fill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ kind: "invoice", input, suggested: draft })
    expect(api.fill).toHaveBeenCalledWith({ prompt: input }, { signal })
  })
  it("drops cancelled and unauthorized requests", async () => {
    vi.useFakeTimers()
    api.capabilities.mockResolvedValue({ aiInvoiceDraft: { requestFallbackEnabled: true } })
    const run = new AbortController()
    const result = suggestRequest(input, () => true, run.signal)
    await vi.advanceTimersByTimeAsync(0)
    run.abort()
    expect(await result).toBeNull()
    expect(await suggestRequest(input, () => false, new AbortController().signal)).toBeNull()
    expect(api.fill).not.toHaveBeenCalled()
  })
})
