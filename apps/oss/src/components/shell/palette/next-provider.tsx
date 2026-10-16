import { overdueInvoices, type Invoice } from '../../command-bar/overdue-invoices'
import { prefetchRequest, readInvoices } from '../../command-bar/request-data'
import { RequestCardSlot } from '../../command-bar/request-card-slot'
import { permittedRequest, recognizeRequest } from '../../command-bar/request-intent'
import { REQUEST_ICONS } from './request-row'
import type { PaletteContext, PaletteItem, PaletteProvider, PaletteSection } from './types'

/**
 * Before anything is typed: what is probably next, read from the invoices and not from a model.
 * Overdue invoices to remind, and the customer last invoiced, again. Each is a request with its
 * card, so choosing it is one key, and nothing happens without the card's own button.
 */
export const nextProvider: PaletteProvider = {
  id: 'next',
  order: 70,
  sections: ({ query, can, t }: PaletteContext) => {
    if (query.trim()) return []
    return readInvoices().then(({ invoices: listed, timezone }): PaletteSection[] => {
      // The list's dates arrive as strings over the wire, as the overdue card reads them too.
      const invoices = listed as unknown as Invoice[]
      const permitted = permittedRequest(recognizeRequest, can)
      const overdue = overdueInvoices(invoices, timezone, new Set())
      const last = invoices.find((invoice) => invoice.status !== 'draft' && invoice.status !== 'void')
      const rows: Array<{ written: string; detail: string }> = [
        ...(overdue.length ? [{ written: 'vis forfaldne fakturaer', detail: [...new Set(overdue.map(({ invoice }) => invoice.contact.name))].slice(0, 2).join(', ') }] : []),
        ...(last ? [{ written: `fakturer ${last.contact.name} som sidst`, detail: last.contact.name }] : []),
      ]
      const items = rows.flatMap(({ written, detail }): PaletteItem[] => {
        const intent = permitted(written)
        if (!intent) return []
        const card: PaletteItem['card'] = ({ close }) => <RequestCardSlot intent={intent} onDismiss={close} autoFocus={false} />
        return [{
          id: `next:${written}`,
          label: written,
          icon: REQUEST_ICONS[intent.kind],
          content: (
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-medium">{t(`shell.request.title.${intent.kind}`)}</span>
              <span className="text-muted-foreground min-w-0 truncate">{detail}</span>
            </span>
          ),
          perform: ({ expand, close }) => expand(<RequestCardSlot intent={intent} onDismiss={close} />),
          card,
          prefetch: () => prefetchRequest(intent),
        }]
      })
      return items.length ? [{ id: 'next', heading: t('shell.palette.groupNext'), items }] : []
    }, () => [])
  },
}
