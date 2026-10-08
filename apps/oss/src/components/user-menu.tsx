import { ChevronsUpDown, LogOut, Monitor, Moon, Sun } from 'lucide-react'

import { authClient, useSession } from '../lib/auth-client'
import { invalidateAppLayoutSession } from '../lib/app-layout-session'
import { loadPage } from '../lib/page-navigation'
import { parseThemePreference, useTheme, type ThemePreference } from '../lib/theme'
import { Avatar, AvatarFallback } from './ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
import type { TranslationKey } from '../lib/i18n/messages'

const themeOptions: Array<{
  value: ThemePreference
  labelKey: TranslationKey
  icon: typeof Monitor
}> = [
  { value: 'system', labelKey: 'user.theme.system', icon: Monitor },
  { value: 'light', labelKey: 'user.theme.light', icon: Sun },
  { value: 'dark', labelKey: 'user.theme.dark', icon: Moon },
]

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export function UserMenu() {
  const { t } = useI18n()
  const { isMobile } = useSidebar()
  const { data: session } = useSession()
  const { preference: themePreference, setPreference: setThemePreference } = useTheme()

  const user = session?.user

  async function handleSignOut() {
    await authClient.signOut()
    // Mainly matters for a back/forward-cache restore; see `invalidateAppLayoutSession`.
    invalidateAppLayoutSession()
    // A new page load, so nothing of this session's organization survives in this tab.
    loadPage('/login')
  }

  if (!user) return null

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
                <AvatarFallback className="rounded-lg bg-brand-soft text-brand-text">
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
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="px-2 py-1 text-xs text-muted-foreground">
              {t('user.theme')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={themePreference}
              onValueChange={(value) => setThemePreference(parseThemePreference(value))}
            >
              {themeOptions.map(({ value, labelKey, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  <Icon className="text-muted-foreground" />
                  {t(labelKey)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
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
