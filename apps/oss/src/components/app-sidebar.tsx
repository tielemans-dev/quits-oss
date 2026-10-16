import { Link, useRouterState, type LinkProps } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from './ui/sidebar'
import { isNavItemActive, visibleNavGroups, type NavItem } from './shell/nav-model'
import { OrgSwitcher } from './shell/org-switcher'
import { isSettingsPath, settingsNavGroups, type SettingsNavItem } from './shell/settings-nav'
import { SkipLink } from './shell/skip-link'
import { useRuntimeDistribution } from '../lib/runtime-distribution'
import { useI18n } from '../lib/i18n/react'

// One signal for the page you are on: a neutral fill. No bullet, no rule, no brand colour.
const NAV_LINK_CLASS =
  'h-8 gap-2.5 rounded-lg px-2 text-sm font-normal text-muted-foreground hover:bg-(--neutral-6) hover:text-foreground data-[active=true]:bg-(--neutral-10) data-[active=true]:font-medium data-[active=true]:text-foreground'

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const { t } = useI18n()
  const { setOpenMobile } = useSidebar()
  const Icon = item.icon
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} className={NAV_LINK_CLASS}>
        <Link
          to={item.path as LinkProps['to']}
          aria-current={active ? 'page' : undefined}
          // On a phone the sidebar is a drawer over the page: choosing a page closes it.
          onClick={() => setOpenMobile(false)}
        >
          <Icon className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span className="min-w-0 truncate">{t(item.labelKey)}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function SettingsNavLink({ item, currentPath }: { item: SettingsNavItem; currentPath: string }) {
  const { t } = useI18n()
  const { setOpenMobile } = useSidebar()
  const path = item.kind === 'billing' ? '/billing' : `/settings/${item.section}`
  const active = currentPath === path
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} className={NAV_LINK_CLASS}>
        <Link
          to={path as LinkProps['to']}
          aria-current={active ? 'page' : undefined}
          onClick={() => setOpenMobile(false)}
        >
          <span className="min-w-0 truncate">{t(item.labelKey)}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/** On a settings page the sidebar lists the settings pages, with a way back to the app on top. */
function SettingsNav({ currentPath }: { currentPath: string }) {
  const { t } = useI18n()
  const { billingEnabled } = useRuntimeDistribution()
  return (
    <nav aria-label={t('settings.nav.label')} className="flex flex-col">
      <SidebarGroup className="px-2 pt-2 pb-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="h-8 gap-1.5 rounded-lg px-2 text-sm font-medium hover:bg-(--neutral-6)">
              <Link to="/" aria-label={t('settings.nav.backLabel')}>
                <ChevronLeft className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <span>{t('settings.nav.back')}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      {settingsNavGroups(billingEnabled).map((group) => (
        <SidebarGroup key={group.id} className="px-2 py-2">
          <SidebarGroupLabel className="h-7 px-2 text-xs font-normal text-muted-foreground">
            {t(group.labelKey)}
          </SidebarGroupLabel>
          <SidebarMenu className="gap-0.5">
            {group.items.map((item) => (
              <SettingsNavLink key={item.labelKey} item={item} currentPath={currentPath} />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </nav>
  )
}

/**
 * The app's sidebar: the organisation on top, then the destinations in groups split by a hairline.
 * Settings pages swap the destinations for the settings pages (see `SettingsNav`).
 * Settings, billing and the user menu live in the top bar (see `AppMain`).
 */
export function AppSidebar() {
  const { t } = useI18n()
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const { billingEnabled } = useRuntimeDistribution()
  const groups = visibleNavGroups(billingEnabled).filter((group) => !group.pinned)

  return (
    <>
      <SkipLink />
      <Sidebar>
        <SidebarHeader className="h-(--topbar-height) justify-center px-2 py-0">
          <OrgSwitcher />
        </SidebarHeader>
        <SidebarContent className="gap-0">
          {isSettingsPath(currentPath) ? <SettingsNav currentPath={currentPath} /> : <nav aria-label={t('shell.nav.label')} className="flex flex-col">
            {groups.map((group, index) => (
              <SidebarGroup
                key={group.id}
                role={group.labelKey ? 'group' : undefined}
                aria-label={group.labelKey ? t(group.labelKey) : undefined}
                className={index === 0 ? 'px-2 py-2' : 'border-t border-hairline px-2 py-2'}
              >
                <SidebarMenu className="gap-0.5">
                  {group.items.map((item) => (
                    <NavLink key={item.path} item={item} active={isNavItemActive(item, currentPath)} />
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            ))}
          </nav>}
        </SidebarContent>
      </Sidebar>
    </>
  )
}
