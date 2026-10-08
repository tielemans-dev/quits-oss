import { useCallback, useEffect, useState } from 'react'

import { parseOrganizationRoles, roleHasPermission } from '../../domain/permissions'
import { authClient, useSession } from '../../lib/auth-client'
import { useRequestOrganizationId } from '../../lib/active-organization'
import type { PaletteCapability } from './palette/types'

const RETRY_AFTER_MS = 10_000
const MAX_RETRIES = 5

type RoleState = { identity: string; role?: string; failed: boolean }

/**
 * Read once for the signed-in identity and the organization this tab acts for. Better Auth's
 * active-role hook also reacts to every organization read, so mounting the switcher used to
 * fetch the same role repeatedly. Only an explicit member-role change needs another read here.
 * Server authorization remains authoritative for every operation.
 */
export function useShellPermissions(): { can: (action: PaletteCapability) => boolean; ready: boolean } {
  const { data: session, isPending } = useSession()
  const organizationId = useRequestOrganizationId()
  const userId = session?.user.id
  const matchesOrganization = session?.session.activeOrganizationId === organizationId
  const identity = !isPending && userId && organizationId && matchesOrganization
    ? JSON.stringify([userId, organizationId]) : null
  const [state, setState] = useState<RoleState | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => authClient.$store.atoms.$activeMemberRoleSignal.listen(() => {
    setRevision(value => value + 1)
  }), [])

  useEffect(() => {
    if (!identity || !organizationId) return
    const requestIdentity = identity
    const requestOrganizationId = organizationId
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function load(attempt: number) {
      try {
        const result = await authClient.organization.getActiveMemberRole({ query: { organizationId: requestOrganizationId } })
        if (result.error) throw result.error
        if (!cancelled) setState({ identity: requestIdentity, role: result.data?.role, failed: false })
      } catch {
        if (cancelled) return
        setState(previous => ({ identity: requestIdentity, role: previous?.identity === identity ? previous.role : undefined, failed: true }))
        if (attempt < MAX_RETRIES) timer = setTimeout(() => { void load(attempt + 1) }, RETRY_AFTER_MS)
      }
    }
    void load(0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [identity, organizationId, revision])

  const current = identity && state?.identity === identity ? state : null
  const role = current?.role
  const can = useCallback(
    (action: PaletteCapability) => role ? roleHasPermission(parseOrganizationRoles(role), action) : false,
    [role]
  )
  return { can, ready: Boolean(role) || Boolean(current?.failed) }
}
