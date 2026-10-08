import { useCallback, useEffect, useRef, useState } from 'react'

import { parseOrganizationRoles, roleHasPermission } from '../../domain/permissions'
import { authClient } from '../../lib/auth-client'
import type { PaletteCapability } from './palette/types'

/** How long to wait before asking again after the role could not be read, and how often to ask. */
const RETRY_AFTER_MS = 10_000
const MAX_RETRIES = 5

/**
 * What the signed-in member may create, from their role in the active organization. One small
 * request per page load (the role); the server still checks every action, so this only decides
 * what the shell offers.
 *
 * While the role is loading nothing is offered. The last role that was read is kept if a later
 * request fails. If it never could be read, nothing is offered either (a failed request must not
 * show actions the member may not have), and the request is repeated a few times.
 */
export function useShellPermissions(): { can: (action: PaletteCapability) => boolean; ready: boolean } {
  const { data, error, refetch } = authClient.useActiveMemberRole()
  const lastKnownRole = useRef<string | undefined>(undefined)
  if (data?.role) lastKnownRole.current = data.role
  const role = data?.role ?? lastKnownRole.current

  const [retries, setRetries] = useState(0)
  useEffect(() => {
    if (role || !error || retries >= MAX_RETRIES) return
    const timer = setTimeout(() => {
      setRetries((count) => count + 1)
      void refetch()
    }, RETRY_AFTER_MS)
    return () => clearTimeout(timer)
  }, [role, error, retries, refetch])

  const can = useCallback(
    (action: PaletteCapability) => (role ? roleHasPermission(parseOrganizationRoles(role), action) : false),
    [role]
  )

  return { can, ready: Boolean(role) || Boolean(error) }
}
