import { FilePlus2, CornerDownRight } from 'lucide-react'

import { visibleNavGroups } from '../nav-model'
import { matchItems } from './match'
import type { PaletteCapability, PaletteContext, PaletteItem, PaletteProvider } from './types'
import type { TranslationKey } from '../../../lib/i18n/messages'

export type CreateAction = {
  id: 'invoice' | 'quote' | 'contact' | 'agreement'
  to: '/invoices/new' | '/quotes/new' | '/contacts/new' | '/agreements/new'
  capability: PaletteCapability
  /** The label in the "+ Ny" menu. */
  menuKey: TranslationKey
  /** The label in the palette, which names the whole action. */
  paletteKey: TranslationKey
  keywords: string[]
}

/** Every "create something" the shell offers, in the order the "+ Ny" menu lists them. */
export const createActions: CreateAction[] = [
  {
    id: 'invoice',
    to: '/invoices/new',
    capability: 'invoice:create',
    menuKey: 'shell.new.invoice',
    paletteKey: 'shell.palette.create.invoice',
    keywords: ['faktura', 'invoice', 'ny', 'new', 'opret'],
  },
  {
    id: 'quote',
    to: '/quotes/new',
    capability: 'quote:create',
    menuKey: 'shell.new.quote',
    paletteKey: 'shell.palette.create.quote',
    keywords: ['tilbud', 'quote', 'ny', 'new', 'opret'],
  },
  {
    id: 'contact',
    to: '/contacts/new',
    capability: 'contact:create',
    menuKey: 'shell.new.contact',
    paletteKey: 'shell.palette.create.contact',
    keywords: ['kunde', 'kontakt', 'contact', 'customer', 'ny', 'new', 'opret'],
  },
  {
    id: 'agreement',
    to: '/agreements/new',
    capability: 'agreement:create',
    menuKey: 'shell.new.agreement',
    paletteKey: 'shell.palette.create.agreement',
    keywords: ['aftale', 'agreement', 'ny', 'new', 'opret'],
  },
]

function pageItems(context: PaletteContext): Array<PaletteItem & { keywords: string[] }> {
  return visibleNavGroups(context.billingEnabled).flatMap((group) =>
    group.items.map((item) => ({
      id: `nav:${item.path}`,
      label: context.t(item.labelKey),
      // The sidebar group says where the page lives; the two ungrouped ones say nothing.
      hint: group.labelKey ? context.t(group.labelKey) : undefined,
      icon: CornerDownRight,
      keywords: item.keywords ?? [],
      perform: ({ navigate }) => navigate(item.path),
    }))
  )
}

/** Pages: every destination in the sidebar. */
export const navigationProvider: PaletteProvider = {
  id: 'navigate',
  order: 200,
  sections: (context) => {
    const items = matchItems(pageItems(context), context.query)
    return items.length ? [{ id: 'navigate', heading: context.t('shell.palette.groupNavigate'), items }] : []
  },
}

/** Create: the same actions as the "+ Ny" menu, for those the person may do. */
export const createProvider: PaletteProvider = {
  id: 'create',
  order: 100,
  sections: (context) => {
    const candidates = createActions
      .filter((action) => context.can(action.capability))
      .map((action) => ({
        id: `create:${action.id}`,
        label: context.t(action.paletteKey),
        icon: FilePlus2,
        keywords: action.keywords,
        perform: ({ navigate }: { navigate: (to: string) => void }) => navigate(action.to),
      }))
    const items = matchItems(candidates, context.query)
    return items.length ? [{ id: 'create', heading: context.t('shell.palette.groupCreate'), items }] : []
  },
}

export const builtinPaletteProviders: PaletteProvider[] = [createProvider, navigationProvider]
