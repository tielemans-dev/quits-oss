import { useNavigate } from '@tanstack/react-router'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { authClient, useSession } from '../../lib/auth-client'
import { switchActiveOrganization, useRequestOrganizationId } from '../../lib/active-organization'
import { useI18n } from '../../lib/i18n/react'
import { cn } from '../../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'

type Organization = {
  id: string
  name: string
  slug: string
  createdAt: Date
  logo?: string | null
  metadata?: unknown
}

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '·'
}

/**
 * The organization identity at the top of the sidebar, and the way to switch between the
 * organizations the person belongs to. Switching loads a new page (see `switchActiveOrganization`).
 */
export function OrgSwitcher({ className }: { className?: string }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { data: session } = useSession()

  const sessionOrgId = session?.session?.activeOrganizationId ?? null
  // The organization this page acts for. It differs from the session's when another tab switched
  // organization; then every organization, the session's included, can be selected to load it.
  const tabOrgId = useRequestOrganizationId()
  const currentOrgId = tabOrgId ?? sessionOrgId
  const inSync = currentOrgId === sessionOrgId

  const [orgs, setOrgs] = useState<Organization[]>([])

  useEffect(() => {
    authClient.organization.list().then((result) => {
      if (result.data) {
        setOrgs(result.data)
      }
    })
  }, [])

  async function handleSwitchOrg(organizationId: string) {
    if (inSync && organizationId === currentOrgId) {
      return
    }

    // Loads a new page acting for the organization once the session switched to it.
    await switchActiveOrganization(organizationId)
  }

  if (!session?.user) return null

  const currentOrg = orgs.find((o) => o.id === currentOrgId)
  const otherOrgs = orgs.filter((o) => o.id !== currentOrgId)
  const name = currentOrg?.name ?? ''

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('shell.org.switch')}
        className={cn(
          'group/org flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left outline-hidden',
          'hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent',
          className
        )}
      >
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand-soft text-[13px] font-bold text-brand-text"
        >
          {name ? initialOf(name) : ''}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{name || ' '}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg">
        <DropdownMenuLabel className="mono-label px-2 py-1">{t('user.organizations')}</DropdownMenuLabel>
        {currentOrg && (
          <DropdownMenuItem className="gap-2" disabled={inSync} onClick={() => handleSwitchOrg(currentOrg.id)}>
            <Check className="size-4 shrink-0" />
            <span className="truncate">{currentOrg.name}</span>
          </DropdownMenuItem>
        )}
        {otherOrgs.map((org) => (
          <DropdownMenuItem key={org.id} className="gap-2" onClick={() => handleSwitchOrg(org.id)}>
            <span className="size-4 shrink-0" />
            <span className="truncate">{org.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2 text-muted-foreground" onClick={() => navigate({ to: '/onboarding' })}>
          <Plus className="size-4 shrink-0" />
          <span>{t('user.createOrganization')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
