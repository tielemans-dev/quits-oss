import { useNavigate } from '@tanstack/react-router'
import { Check, ChevronsUpDown, LogOut, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { authClient, useSession } from '../lib/auth-client'
import { switchActiveOrganization, useRequestOrganizationId } from '../lib/active-organization'
import { loadPage } from '../lib/page-navigation'
import { Avatar, AvatarFallback } from './ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from './ui/sidebar'
import { useI18n } from '../lib/i18n/react'

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

type Organization = {
  id: string
  name: string
  slug: string
  createdAt: Date
  logo?: string | null
  metadata?: unknown
}

export function UserMenu() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { isMobile } = useSidebar()
  const { data: session } = useSession()

  const user = session?.user
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

  async function handleSignOut() {
    await authClient.signOut()
    // A new page load, so nothing of this session's organization survives in this tab.
    loadPage('/login')
  }

  async function handleSwitchOrg(organizationId: string) {
    if (inSync && organizationId === currentOrgId) {
      return
    }

    // Loads a new page acting for the organization once the session switched to it.
    await switchActiveOrganization(organizationId)
  }

  if (!user) return null

  const currentOrg = orgs.find((o) => o.id === currentOrgId)
  const otherOrgs = orgs.filter((o) => o.id !== currentOrgId)

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg">
                  {getInitials(user.name ?? user.email)}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {user.name ?? t('user.defaultName')}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="size-8 rounded-lg">
                  <AvatarFallback className="rounded-lg">
                    {getInitials(user.name ?? user.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">
                    {user.name ?? t('user.defaultName')}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            {orgs.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="px-2 py-1 text-xs text-muted-foreground">
                  {t('user.organizations')}
                </DropdownMenuLabel>
                {currentOrg && (
                  <DropdownMenuItem
                    className="gap-2"
                    disabled={inSync}
                    onClick={() => handleSwitchOrg(currentOrg.id)}
                  >
                    <Check className="size-4 shrink-0" />
                    <span className="truncate">{currentOrg.name}</span>
                  </DropdownMenuItem>
                )}
                {otherOrgs.map((org) => (
                  <DropdownMenuItem
                    key={org.id}
                    className="gap-2"
                    onClick={() => handleSwitchOrg(org.id)}
                  >
                    <span className="size-4 shrink-0" />
                    <span className="truncate">{org.name}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem
                  className="gap-2 text-muted-foreground"
                  onClick={() => navigate({ to: '/onboarding' })}
                >
                  <Plus className="size-4 shrink-0" />
                  <span>{t('user.createOrganization')}</span>
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut}>
              <LogOut />
              {t('user.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
