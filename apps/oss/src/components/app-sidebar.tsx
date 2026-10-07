import { Link, useRouterState, type LinkProps } from '@tanstack/react-router'
import {
  LayoutDashboard,
  FileText,
  ClipboardList,
  Users,
  CreditCard,
  Settings,
  Package,
  FileMinus,
  Repeat,
  ShieldCheck,
} from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from './ui/sidebar'
import { UserMenu } from './user-menu'
import { billingEnabled } from '../lib/distribution'
import { useI18n } from '../lib/i18n/react'
import type { TranslationKey } from '../lib/i18n/messages'

const navItems: Array<{
  key: TranslationKey
  icon: typeof LayoutDashboard
  path: string
}> = [
  { key: 'nav.dashboard', icon: LayoutDashboard, path: '/' },
  { key: 'nav.invoices', icon: FileText, path: '/invoices' },
  { key: 'nav.creditNotes', icon: FileMinus, path: '/credit-notes' },
  { key: 'nav.recurring', icon: Repeat, path: '/recurring' },
  { key: 'nav.quotes', icon: ClipboardList, path: '/quotes' },
  { key: 'nav.contacts', icon: Users, path: '/contacts' },
  { key: 'nav.approvals', icon: ShieldCheck, path: '/approvals' },
  { key: 'nav.billing', icon: CreditCard, path: '/billing' },
  { key: 'nav.settings', icon: Settings, path: '/settings' },
  { key: 'nav.catalog', icon: Package, path: '/catalog' },
]

export function AppSidebar() {
  const { t } = useI18n()
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const visibleNavItems = billingEnabled
    ? navItems
    : navItems.filter((item) => item.path !== '/billing')

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="text-lg font-bold tracking-tight">Quits</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t('nav.navigation')}</SidebarGroupLabel>
          <SidebarMenu>
            {visibleNavItems.map((item) => {
              const isActive =
                item.path === '/'
                  ? currentPath === '/'
                  : currentPath.startsWith(item.path)

              return (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive}
                    tooltip={t(item.key)}
                  >
                    <Link to={item.path as LinkProps['to']}>
                      <item.icon />
                      <span>{t(item.key)}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
    </Sidebar>
  )
}
