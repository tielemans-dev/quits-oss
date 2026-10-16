import {
  CreditCard,
  FileMinus,
  FilePen,
  FileText,
  Handshake,
  House,
  ListChecks,
  Package,
  Repeat,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react'

import type { TranslationKey } from '../../lib/i18n/messages'

export type NavPath =
  | '/'
  | '/invoices'
  | '/quotes'
  | '/agreements'
  | '/recurring'
  | '/contacts'
  | '/catalog'
  | '/credit-notes'
  | '/approvals'
  | '/billing'
  | '/settings'

export type NavItem = {
  path: NavPath
  labelKey: TranslationKey
  /** Shown before the label in the sidebar (16px, stroke 1.5). */
  icon: LucideIcon
  /** Words the command palette also matches, besides the translated label. */
  keywords?: string[]
  /** Only shown when the deployment has billing; see `useRuntimeDistribution`. */
  requiresBilling?: boolean
}

export type NavGroup = {
  id: string
  /** `null` for a group that stands without a label. */
  labelKey: TranslationKey | null
  items: NavItem[]
  /** Sits at the bottom of the sidebar instead of in the scrolling list. */
  pinned?: boolean
}

/**
 * Every destination of the app shell, in order. Mirrors the routes that exist; a new page needs an
 * entry here to be reachable from the sidebar and the command palette.
 */
export const navGroups: NavGroup[] = [
  {
    id: 'home',
    labelKey: null,
    items: [
      { path: '/', labelKey: 'nav.dashboard', icon: House, keywords: ['dashboard', 'oversigt', 'forside'] },
      { path: '/approvals', labelKey: 'nav.approvals', icon: ListChecks, keywords: ['approvals', 'agent', 'agenter'] },
    ],
  },
  {
    id: 'sales',
    labelKey: 'nav.group.sales',
    items: [
      { path: '/invoices', labelKey: 'nav.invoices', icon: FileText, keywords: ['invoices', 'regninger'] },
      { path: '/quotes', labelKey: 'nav.quotes', icon: FilePen, keywords: ['quotes', 'tilbud', 'tilbudsgivning'] },
      { path: '/agreements', labelKey: 'nav.agreements', icon: Handshake, keywords: ['agreements', 'kontrakter'] },
      { path: '/recurring', labelKey: 'nav.recurring', icon: Repeat, keywords: ['recurring', 'abonnement', 'gentagne'] },
    ],
  },
  {
    id: 'customers-catalog',
    labelKey: 'nav.group.customersCatalog',
    items: [
      { path: '/contacts', labelKey: 'nav.contacts', icon: Users, keywords: ['contacts', 'kontakter', 'customers'] },
      { path: '/catalog', labelKey: 'nav.catalog', icon: Package, keywords: ['catalog', 'varer', 'produkter', 'ydelser'] },
    ],
  },
  {
    id: 'money',
    labelKey: 'nav.group.money',
    items: [
      { path: '/credit-notes', labelKey: 'nav.creditNotes', icon: FileMinus, keywords: ['credit notes', 'kreditnota'] },
    ],
  },
  {
    id: 'settings',
    labelKey: null,
    pinned: true,
    items: [
      { path: '/billing', labelKey: 'nav.billing', icon: CreditCard, requiresBilling: true, keywords: ['billing', 'plan'] },
      { path: '/settings', labelKey: 'nav.settings', icon: Settings, keywords: ['settings', 'indstillinger', 'firma'] },
    ],
  },
]

/** The groups a deployment shows: items that need billing are dropped where it is off. */
export function visibleNavGroups(billingEnabled: boolean): NavGroup[] {
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => billingEnabled || !item.requiresBilling),
    }))
    .filter((group) => group.items.length > 0)
}

/** Whether `currentPath` is on `item`'s page or below it (`/invoices/inv_1` is on `/invoices`). */
export function isNavItemActive(item: Pick<NavItem, 'path'>, currentPath: string): boolean {
  if (item.path === '/') return currentPath === '/'
  return currentPath === item.path || currentPath.startsWith(`${item.path}/`)
}
