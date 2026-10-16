import { Link, useRouterState, type LinkProps } from '@tanstack/react-router'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from './ui/sidebar'
import { isNavItemActive, visibleNavGroups, type NavItem } from './shell/nav-model'
import { OrgSwitcher } from './shell/org-switcher'
import { SkipLink } from './shell/skip-link'
import { useRuntimeDistribution } from '../lib/runtime-distribution'
import { useI18n } from '../lib/i18n/react'

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const { t } = useI18n()
  const { setOpenMobile } = useSidebar()
  const Icon = item.icon
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        // One signal for the page you are on: a neutral fill. No bullet, no rule, no brand colour.
        className="h-8 gap-2.5 rounded-lg px-2 text-sm font-normal text-muted-foreground hover:bg-(--neutral-6) hover:text-foreground data-[active=true]:bg-(--neutral-10) data-[active=true]:font-medium data-[active=true]:text-foreground"
      >
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

/**
 * The app's sidebar: the organisation on top, then the destinations in groups split by a hairline.
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
          <nav aria-label={t('shell.nav.label')} className="flex flex-col">
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
          </nav>
        </SidebarContent>
      </Sidebar>
    </>
  )
}
