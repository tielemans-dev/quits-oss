import type { TranslationKey } from '../../lib/i18n/messages'

/** The pages of Settings. Each one is `/settings/<section>`. */
export const SETTINGS_SECTIONS = [
  'company',
  'invoicing',
  'payments',
  'email',
  'reminders',
  'team',
  'ai',
  'accounting',
  'audit',
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'company'

export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value)
}

export type SettingsNavItem =
  | { kind: 'section'; section: SettingsSection; labelKey: TranslationKey }
  | { kind: 'billing'; labelKey: TranslationKey }

export type SettingsNavGroup = { id: string; labelKey: TranslationKey; items: SettingsNavItem[] }

const section = (id: SettingsSection): SettingsNavItem => ({
  kind: 'section',
  section: id,
  labelKey: `settings.nav.${id}` as const,
})

/** The settings sidebar, grouped the way the pages are. Billing only shows where it is offered. */
export function settingsNavGroups(billingEnabled: boolean): SettingsNavGroup[] {
  return [
    {
      id: 'company',
      labelKey: 'settings.nav.group.company',
      items: [
        section('company'),
        ...(billingEnabled ? [{ kind: 'billing', labelKey: 'settings.nav.billing' } as const] : []),
        section('invoicing'),
        section('payments'),
        section('email'),
        section('reminders'),
      ],
    },
    { id: 'team', labelKey: 'settings.nav.group.team', items: [section('team'), section('ai')] },
    { id: 'integrations', labelKey: 'settings.nav.group.integrations', items: [section('accounting')] },
    { id: 'security', labelKey: 'settings.nav.group.security', items: [section('audit')] },
  ]
}

/** Settings takes over the sidebar on its own pages and on billing, which is listed among them. */
export function isSettingsPath(pathname: string) {
  return pathname === '/settings' || pathname.startsWith('/settings/') || pathname === '/billing'
}
