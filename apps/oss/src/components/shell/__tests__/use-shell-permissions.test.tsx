// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const roleQuery = vi.hoisted(() => ({
  state: { data: undefined, error: null } as { data?: { role: string }; error: unknown },
  refetch: vi.fn(),
}))

vi.mock("../../../lib/auth-client", () => ({
  authClient: { useActiveMemberRole: () => ({ ...roleQuery.state, refetch: roleQuery.refetch }) },
}))

import { useShellPermissions } from "../use-shell-permissions"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  roleQuery.state = { data: undefined, error: null }
  roleQuery.refetch.mockReset()
})

describe("shell permissions", () => {
  it("offers nothing while the role is loading", () => {
    const { result } = renderHook(() => useShellPermissions())
    expect(result.current.ready).toBe(false)
    expect(result.current.can("invoice:create")).toBe(false)
  })

  it("follows the role: a member creates, an accountant does not", () => {
    roleQuery.state = { data: { role: "member" }, error: null }
    const member = renderHook(() => useShellPermissions())
    expect(member.result.current.ready).toBe(true)
    expect(member.result.current.can("invoice:create")).toBe(true)

    roleQuery.state = { data: { role: "accountant" }, error: null }
    const accountant = renderHook(() => useShellPermissions())
    expect(accountant.result.current.can("invoice:create")).toBe(false)
    expect(accountant.result.current.can("contact:create")).toBe(false)
  })

  it("keeps the last known role when a later request fails", () => {
    roleQuery.state = { data: { role: "accountant" }, error: null }
    const { result, rerender } = renderHook(() => useShellPermissions())

    roleQuery.state = { data: undefined, error: new Error("offline") }
    rerender()

    expect(result.current.can("invoice:create")).toBe(false)
    expect(result.current.can("quote:create")).toBe(false)
  })

  it("fails closed when the role was never read, and asks again", async () => {
    roleQuery.state = { data: undefined, error: new Error("offline") }
    const { result } = renderHook(() => useShellPermissions())

    expect(result.current.ready).toBe(true)
    expect(result.current.can("invoice:create")).toBe(false)
    expect(roleQuery.refetch).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(roleQuery.refetch).toHaveBeenCalledTimes(1)
  })

  it("stops asking after a few tries", async () => {
    roleQuery.state = { data: undefined, error: new Error("offline") }
    const { rerender } = renderHook(() => useShellPermissions())

    for (let attempt = 0; attempt < 8; attempt++) {
      await act(async () => {
        vi.advanceTimersByTime(10_000)
      })
      rerender()
    }
    expect(roleQuery.refetch).toHaveBeenCalledTimes(5)
  })
})
