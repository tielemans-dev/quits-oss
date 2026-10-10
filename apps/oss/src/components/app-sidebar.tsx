import { Link, useRouterState, type LinkProps } from '@tanstack/react-router'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from './ui/sidebar'
import { QuitsWordmark } from './brand/quits-wordmark'
import { isNavItemActive, visibleNavGroups, type NavItem } from './shell/nav-model'
import { OrgSwitcher } from './shell/org-switcher'
import { SkipLink } from './shell/skip-link'
import { UserMenu } from './user-menu'
import { useRuntimeDistribution } from '../lib/runtime-distribution'
import { useI18n } from '../lib/i18n/react'
import { cn } from '../lib/utils'

/** The brand's double rule as two 1px lines under the label of the page you are on. */
const ACTIVE_RULE =
  'bg-[linear-gradient(var(--brand-text),var(--brand-text)),linear-gradient(var(--brand-text),var(--brand-text))] bg-[length:100%_1px] bg-[position:0_100%,0_calc(100%-3px)] bg-no-repeat pb-1 -mb-1'

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const { t } = useI18n()
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        className="h-8 gap-2.5 px-2.5 text-[13.5px] font-medium text-muted-foreground hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground"
      >
        <Link
          to={item.path as LinkProps['to']}
          aria-current={active ? 'page' : undefined}
          // On a phone the sidebar is a drawer over the page: choosing a page closes it.
          onClick={() => setOpenMobile(false)}
        >
          <span
            aria-hidden="true"
            className={cn('size-1.5 shrink-0 rounded-[2px] bg-current opacity-35', active && 'bg-settled opacity-100')}
          />
          <span className={cn('min-w-0', active && ACTIVE_RULE)}>{t(item.labelKey)}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function AppSidebar() {
  const { t } = useI18n()
  const { setOpenMobile } = useSidebar()
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const { billingEnabled } = useRuntimeDistribution()
  const groups = visibleNavGroups(billingEnabled)
  const scrolling = groups.filter((group) => !group.pinned)
  const pinned = groups.filter((group) => group.pinned)

  return (
    <>
      <SkipLink />
      {/* The one light source: a faint wash from the top left behind the identity. It sits
          behind the page canvas, so only bare canvas shows it. */}
      <div
        aria-hidden="true"
        className="bg-brand-glow pointer-events-none fixed top-0 left-0 -z-10 h-[520px] w-[40vw] max-md:hidden"
      />
      <Sidebar>
        <SidebarHeader className="relative gap-3 px-3 pt-4 pb-2">
          <div
            aria-hidden="true"
            className="bg-brand-glow pointer-events-none absolute inset-x-0 top-0 h-56 md:hidden"
          />
          <Link
            to="/"
            aria-label="quits"
            onClick={() => setOpenMobile(false)}
            className="relative ml-2 w-fit rounded-sm outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <QuitsWordmark className="text-[22px]" />
          </Link>
          <OrgSwitcher className="relative" />
        </SidebarHeader>
        <SidebarContent className="px-3">
          <nav aria-label={t('shell.nav.label')} className="flex flex-col">
            {scrolling.map((group) => (
              <SidebarGroup
                key={group.id}
                role={group.labelKey ? 'group' : undefined}
                aria-labelledby={group.labelKey ? `nav-group-${group.id}` : undefined}
                className="p-0"
              >
                {group.labelKey && (
                  <div id={`nav-group-${group.id}`} className="mono-label px-2.5 pt-5 pb-1.5">
                    {t(group.labelKey)}
                  </div>
                )}
                <SidebarMenu>
                  {group.items.map((item) => (
                    <NavLink key={item.path} item={item} active={isNavItemActive(item, currentPath)} />
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            ))}
          </nav>
        </SidebarContent>
        <SidebarFooter className="gap-2 px-3 pt-2 pb-3">
          {pinned.map((group) => (
            <nav key={group.id} aria-label={t('shell.nav.account')} className="border-t border-hairline pt-2">
              <SidebarMenu>
                {group.items.map((item) => (
                  <NavLink key={item.path} item={item} active={isNavItemActive(item, currentPath)} />
                ))}
              </SidebarMenu>
            </nav>
          ))}
          <UserMenu />
        </SidebarFooter>
      </Sidebar>
    </>
  )
}
