// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  session: { data: { user: { id: 'u1' }, session: { activeOrganizationId: 'org1' } }, isPending: false } as { data: { user: { id: string }; session: { activeOrganizationId: string } } | null; isPending: boolean },
  organizationId: 'org1', getRole: vi.fn(), listeners: new Set<() => void>(),
}))
vi.mock('../../../lib/auth-client', () => ({
  useSession: () => auth.session,
  authClient: {
    organization: { getActiveMemberRole: auth.getRole },
    $store: { atoms: { $activeMemberRoleSignal: { listen: (callback: () => void) => { auth.listeners.add(callback); return () => auth.listeners.delete(callback) } } } },
  },
}))
vi.mock('../../../lib/active-organization', () => ({ useRequestOrganizationId: () => auth.organizationId }))
import { useShellPermissions } from '../use-shell-permissions'

beforeEach(() => {
  vi.useFakeTimers()
  auth.session = { data: { user: { id: 'u1' }, session: { activeOrganizationId: 'org1' } }, isPending: false }
  auth.organizationId = 'org1'
  auth.getRole.mockReset().mockResolvedValue({ data: { role: 'member' }, error: null })
})
afterEach(() => { cleanup(); vi.useRealTimers() })
const flush = () => act(async () => { await Promise.resolve() })

describe('shell permissions', () => {
  it('waits for the session, then reads the explicit organization only once across rerenders', async () => {
    auth.session.isPending = true
    const { result, rerender } = renderHook(() => useShellPermissions())
    expect(result.current.can('invoice:create')).toBe(false)
    expect(auth.getRole).not.toHaveBeenCalled()
    auth.session.isPending = false
    rerender()
    await flush()
    rerender()
    await flush()
    expect(auth.getRole).toHaveBeenCalledExactlyOnceWith({ query: { organizationId: 'org1' } })
    expect(result.current.can('invoice:create')).toBe(true)
  })

  it('refreshes after an explicit role change and retains a known role on transient failure', async () => {
    auth.getRole.mockResolvedValue({ data: { role: 'accountant' } })
    const { result } = renderHook(() => useShellPermissions())
    await flush()
    expect(result.current.can('invoice:create')).toBe(false)
    auth.getRole.mockResolvedValue({ error: { message: 'offline' } })
    await act(async () => { for (const listener of auth.listeners) listener() })
    expect(auth.getRole).toHaveBeenCalledTimes(2)
    expect(result.current.ready).toBe(true)
    expect(result.current.can('invoice:create')).toBe(false)
  })

  it('never keeps another identity role or accepts its late response', async () => {
    let resolve!: (value: unknown) => void
    auth.getRole.mockReturnValue(new Promise(r => { resolve = r }))
    const { result, rerender } = renderHook(() => useShellPermissions())
    auth.session.data = null
    rerender()
    await act(async () => { resolve({ data: { role: 'admin' } }) })
    expect(result.current.can('invoice:create')).toBe(false)
    expect(result.current.ready).toBe(false)
  })

  it('fails closed when another tab changes organization', async () => {
    const { result, rerender } = renderHook(() => useShellPermissions())
    await flush()
    expect(result.current.can('invoice:create')).toBe(true)
    auth.session.data!.session.activeOrganizationId = 'org2'
    rerender()
    expect(result.current.can('invoice:create')).toBe(false)
    expect(auth.getRole).toHaveBeenCalledTimes(1)
  })

  it('fails closed and limits retries to five after the initial attempt', async () => {
    auth.getRole.mockRejectedValue(new Error('offline'))
    const { result, unmount } = renderHook(() => useShellPermissions())
    await flush()
    expect(result.current.ready).toBe(true)
    expect(result.current.can('invoice:create')).toBe(false)
    for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(auth.getRole).toHaveBeenCalledTimes(6)
    unmount()
    expect(auth.listeners.size).toBe(0)
  })
})
