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
      { path: '/', labelKey: 'nav.dashboard', keywords: ['dashboard', 'oversigt', 'forside'] },
      { path: '/approvals', labelKey: 'nav.approvals', keywords: ['approvals', 'agent', 'agenter'] },
    ],
  },
  {
    id: 'sales',
    labelKey: 'nav.group.sales',
    items: [
      { path: '/invoices', labelKey: 'nav.invoices', keywords: ['invoices', 'regninger'] },
      { path: '/quotes', labelKey: 'nav.quotes', keywords: ['quotes', 'tilbud', 'tilbudsgivning'] },
      { path: '/agreements', labelKey: 'nav.agreements', keywords: ['agreements', 'kontrakter'] },
      { path: '/recurring', labelKey: 'nav.recurring', keywords: ['recurring', 'abonnement', 'gentagne'] },
    ],
  },
  {
    id: 'customers-catalog',
    labelKey: 'nav.group.customersCatalog',
    items: [
      { path: '/contacts', labelKey: 'nav.contacts', keywords: ['contacts', 'kontakter', 'customers'] },
      { path: '/catalog', labelKey: 'nav.catalog', keywords: ['catalog', 'varer', 'produkter', 'ydelser'] },
    ],
  },
  {
    id: 'money',
    labelKey: 'nav.group.money',
    items: [
      { path: '/credit-notes', labelKey: 'nav.creditNotes', keywords: ['credit notes', 'kreditnota'] },
    ],
  },
  {
    id: 'settings',
    labelKey: null,
    pinned: true,
    items: [
      { path: '/billing', labelKey: 'nav.billing', requiresBilling: true, keywords: ['billing', 'plan'] },
      { path: '/settings', labelKey: 'nav.settings', keywords: ['settings', 'indstillinger', 'firma'] },
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
export function isNavItemActive(item: NavItem, currentPath: string): boolean {
  if (item.path === '/') return currentPath === '/'
  return currentPath === item.path || currentPath.startsWith(`${item.path}/`)
}
