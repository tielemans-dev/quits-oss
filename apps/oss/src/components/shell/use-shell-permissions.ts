import { useCallback } from 'react'

import { parseOrganizationRoles, roleHasPermission } from '../../domain/permissions'
import { authClient } from '../../lib/auth-client'
import type { PaletteCapability } from './palette/types'

/**
 * What the signed-in member may create, from their role in the active organization. One small
 * request per page load (the role); the server still checks every action, so this only decides
 * what the shell offers. While the role is loading nothing is offered, and if it cannot be read
 * everything is, so a failed request never locks someone out of creating.
 */
export function useShellPermissions(): { can: (action: PaletteCapability) => boolean; ready: boolean } {
  const { data, error } = authClient.useActiveMemberRole()
  const role = data?.role

  const can = useCallback(
    (action: PaletteCapability) => {
      if (error) return true
      if (!role) return false
      return roleHasPermission(parseOrganizationRoles(role), action)
    },
    [role, error]
  )

  return { can, ready: Boolean(role) || Boolean(error) }
}
