import { Banknote, FileMinus, FilePlus, Repeat, User, type LucideIcon } from 'lucide-react'

import { formatCurrency } from '../../../lib/i18n/format'
import { useI18n } from '../../../lib/i18n/react'
import { normalize } from '../../../lib/request-parser'
import { cn } from '../../../lib/utils'
import { prefetchRequest } from '../../command-bar/request-data'
import { stagger } from '../../command-bar/request-card-slot'
import { recognizeRequest } from '../../command-bar/request-intent'
import { loadKnown, peekKnown, type Known } from './known'
import type { PaletteActions, PaletteContext, PaletteItem, PaletteProvider, PaletteSection } from './types'

const issued = (invoice: Known['invoices'][number]) => invoice.status !== 'draft' && invoice.status !== 'void'

/** 12500.5 as "12.500,50", the way a payment request is written. */
const kroner = (amount: number) => {
  const [whole, fraction] = amount.toFixed(2).split('.')
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return fraction === '00' ? grouped : `${grouped},${fraction}`
}

/** Customers offered for one name; the others wait beside the first as chips. */
const SHOWN = 3

/**
 * The customers `query` names on its own: the start of the name first, then the start of any word
 * in it ("studio" finds Studio Vester, "vester" too).
 */
export function customersFor(query: string, known: Known): string[] {
  const typed = normalize(query)
  if (typed.length < 3) return []
  const starts = (name: string) => normalize(name).startsWith(typed)
  const found = known.customers.filter(({ name }) => starts(name) || normalize(name).split(' ').some((word) => word.startsWith(typed)))
  return found.sort((a, b) => Number(starts(b.name)) - Number(starts(a.name))).slice(0, SHOWN).map(({ name }) => name)
}

/**
 * A customer's name alone is where many requests start: who first, then what. The palette becomes
 * the customer: what they owe, their latest invoices, and the requests that fit them, one key
 * away. Choosing one writes it into the field, where it becomes its own card.
 */
export const customerProvider: PaletteProvider = {
  id: 'customer',
  order: 78,
  sections: ({ query, can, t }: PaletteContext) => {
    if (!can('contact:read') || recognizeRequest(query)) return []
    const section = (known: Known): PaletteSection[] => {
      const items = customersFor(query, known).map((name): PaletteItem => ({
        id: `customer:${name}`,
        label: name,
        icon: User,
        perform: ({ fill }) => fill(`fakturer ${name} `),
        card: (actions) => <CustomerCard name={name} known={known} actions={actions} />,
        prefetch: () => prefetchRequest({ kind: 'invoice', input: `fakturer ${name}` }),
      }))
      return items.length ? [{ id: 'customer', heading: t('shell.palette.groupCustomer'), items }] : []
    }
    const known = peekKnown()
    // Never a wait: opening the palette loads customers, and a search is not held up for them.
    if (!known) void loadKnown()
    return known ? section(known) : []
  },
}

export function CustomerCard({ name, known, actions }: { name: string; known: Known; actions: PaletteActions }) {
  const { t, locale } = useI18n()
  const invoices = known.invoices.filter((invoice) => invoice.customer === name && issued(invoice))
  const open = invoices.filter((invoice) => invoice.balanceDue > 0)
  const today = new Date().toISOString().slice(0, 10)
  const late = (invoice: Known['invoices'][number]) => invoice.balanceDue > 0 && invoice.dueDate.slice(0, 10) < today
  const owed = open.filter((invoice) => invoice.currency === 'DKK').reduce((sum, invoice) => sum + invoice.balanceDue, 0)
  const latest = invoices[0]
  const initials = name.split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase()

  const next: Array<{ label: string; icon: LucideIcon; text: string }> = [
    ...(latest ? [{ label: t('shell.customerCard.again'), icon: Repeat, text: `fakturer ${name} som sidst` }] : []),
    { label: t('shell.customerCard.invoice'), icon: FilePlus, text: `fakturer ${name} ` },
    ...(open[0] ? [{ label: t('shell.customerCard.payment'), icon: Banknote, text: `betaling modtaget fra ${name} ${kroner(open[0].balanceDue)} kr ref ${open[0].number}` }] : []),
    ...(latest ? [{ label: t('shell.customerCard.credit'), icon: FileMinus, text: `kreditnota ${latest.number}` }] : []),
  ]

  return (
    <div className="request-stagger space-y-4 p-4">
      <div {...stagger(0)} className="flex items-center gap-3">
        <span className="bg-sidebar-accent text-foreground flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold">{initials}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{name}</p>
          <p className="text-muted-foreground text-sm tabular-nums">
            {owed > 0 ? `${t('shell.customerCard.outstanding')} ${formatCurrency(owed, 'DKK', locale)}` : t('shell.customerCard.settled')}
          </p>
        </div>
      </div>
      <ul {...stagger(1)} className="divide-hairline divide-y text-sm">
        {invoices.length === 0 && <li className="text-muted-foreground py-2">{t('shell.customerCard.none')}</li>}
        {invoices.slice(0, 3).map((invoice) => (
          <li key={invoice.number} className="flex items-center justify-between gap-3 py-2">
            <span className="font-mono text-xs">{invoice.number}</span>
            <span className={cn('ml-auto text-xs', late(invoice) ? 'text-tone-warning' : 'text-muted-foreground')}>
              {late(invoice) ? t('shell.customerCard.overdue') : invoice.balanceDue > 0 ? t('shell.customerCard.open') : t('shell.customerCard.paid')}
            </span>
            <span className="w-28 text-right tabular-nums">{invoice.balanceDue > 0 ? formatCurrency(invoice.balanceDue, invoice.currency, locale) : ''}</span>
          </li>
        ))}
      </ul>
      <div {...stagger(2)} className="flex flex-wrap gap-2">
        {next.map(({ label, icon: Icon, text }, index) => (
          <button
            key={text}
            type="button"
            data-primary={index === 0 ? '' : undefined}
            onClick={() => actions.fill(text)}
            className="border-hairline hover:bg-sidebar-accent focus-visible:ring-ring flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors duration-(--duration-fade) outline-none focus-visible:ring-2"
          >
            <Icon className="text-muted-foreground size-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
