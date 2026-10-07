// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(),
  session: { data: { session: { activeOrganizationId: "org_a" } }, isPending: false } as {
    data: { session: { activeOrganizationId: string | null } } | null
    isPending: boolean
  },
}))

vi.mock("../../../trpc/client", () => ({
  trpc: { recurring: { capabilities: { query: mocks.capabilities } } },
}))

vi.mock("../../../lib/auth-client", () => ({
  useSession: () => mocks.session,
}))

import { useRecurringCapabilities } from "../use-recurring-capabilities"

function switchOrganization(organizationId: string) {
  mocks.session = { data: { session: { activeOrganizationId: organizationId } }, isPending: false }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  switchOrganization("org_a")
})

describe("useRecurringCapabilities", () => {
  it("drops the old organization's capabilities and refetches after switching organization", async () => {
    mocks.capabilities.mockResolvedValueOnce({ canCreate: true, canUpdate: true })
    const { result, rerender } = renderHook(() => useRecurringCapabilities())
    await waitFor(() => expect(result.current).toEqual({ canCreate: true, canUpdate: true }))

    // The accountant's organization answers later; nothing is allowed meanwhile.
    const next = deferred<{ canCreate: boolean; canUpdate: boolean }>()
    mocks.capabilities.mockReturnValueOnce(next.promise)
    switchOrganization("org_b")
    rerender()
    expect(result.current).toEqual({ canCreate: false, canUpdate: false })

    await act(async () => next.resolve({ canCreate: false, canUpdate: false }))
    expect(result.current).toEqual({ canCreate: false, canUpdate: false })
    expect(mocks.capabilities).toHaveBeenCalledTimes(2)
  })

  it("grants controls once the new organization allows them", async () => {
    mocks.capabilities.mockResolvedValueOnce({ canCreate: false, canUpdate: false })
    const { result, rerender } = renderHook(() => useRecurringCapabilities())
    await waitFor(() => expect(mocks.capabilities).toHaveBeenCalledTimes(1))

    mocks.capabilities.mockResolvedValueOnce({ canCreate: true, canUpdate: true })
    switchOrganization("org_b")
    rerender()
    await waitFor(() => expect(result.current).toEqual({ canCreate: true, canUpdate: true }))
  })

  it("ignores a late answer from the previous organization", async () => {
    const stale = deferred<{ canCreate: boolean; canUpdate: boolean }>()
    mocks.capabilities.mockReturnValueOnce(stale.promise)
    const { result, rerender } = renderHook(() => useRecurringCapabilities())
    await waitFor(() => expect(mocks.capabilities).toHaveBeenCalledTimes(1))

    mocks.capabilities.mockResolvedValueOnce({ canCreate: false, canUpdate: false })
    switchOrganization("org_b")
    rerender()
    await waitFor(() => expect(mocks.capabilities).toHaveBeenCalledTimes(2))
    await act(async () => stale.resolve({ canCreate: true, canUpdate: true }))
    expect(result.current).toEqual({ canCreate: false, canUpdate: false })
  })
})
