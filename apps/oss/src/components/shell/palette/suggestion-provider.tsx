import { prefetchRequest } from '../../command-bar/request-data'
import { RequestCardSlot } from '../../command-bar/request-card-slot'
import { permittedRequest, recognizeRequest, type RequestRecognizer } from '../../command-bar/request-intent'
import { loadKnown, peekKnown, type Known } from './known'
import { fold } from './match'
import { REQUEST_ICONS } from './request-row'
import type { PaletteContext, PaletteItem, PaletteProvider, PaletteSection } from './types'

/** Requests that read the same every time; typing any start of one offers the whole of it. */
const PHRASES = ['vis forfaldne fakturaer', 'hvem har ikke betalt', 'vis moms', 'ny kunde']
const SHOWN = 5

/**
 * Whole requests for what is half typed: the start of a phrase, "kreditnota" and the start of an
 * invoice number or customer, "fakturer" and the start of a customer's name. A request is never
 * met with "no results" while it is still being typed. One suggestion alone carries its card, so
 * the palette becomes it as typing pauses; with several, the list stays for the person to choose.
 */
const typedOf = (query: string) => fold(query).replace(/\s+/g, ' ').trimStart()

/** Whether suggestions for `query` come from invoices and customers, and so have to wait for them. */
const grounded = (typed: string) =>
  /^(?:kreditnota|fakturer|faktura til)\s/.test(typed) || (typed.length >= 4 && ('kreditnota'.startsWith(typed) || 'fakturer'.startsWith(typed)))

export function suggestions(query: string, known: Known | null): string[] {
  const typed = typedOf(query)
  if (typed.trim().length < 2) return []
  const starts = (whole: string) => whole.startsWith(typed) && whole !== typed.trim()
  // A phrase already typed far enough to read as its request needs no completing.
  const out = recognizeRequest(query) ? [] : PHRASES.filter(starts)
  if (!known) return out

  const credit = /^kreditnota\s+(.*)$/.exec(typed)
  if (credit || (typed.length >= 4 && 'kreditnota'.startsWith(typed))) {
    const part = credit?.[1]?.trim() ?? ''
    const exact = known.invoices.some((invoice) => fold(invoice.number) === part)
    if (!exact) {
      out.push(...known.invoices
        .filter((invoice) => fold(invoice.number).includes(part) || fold(invoice.customer).startsWith(part))
        .map((invoice) => `kreditnota ${invoice.number}`))
    }
  }

  // Only while the name is still being typed: a number starts the line, and the name is done.
  const invoice = /^(fakturer|faktura til)\s+([^\d]*)$/.exec(typed)
  if (invoice || (typed.length >= 4 && 'fakturer'.startsWith(typed))) {
    const part = invoice?.[2]?.trim() ?? ''
    if (!known.customers.some((customer) => fold(customer.name) === part)) {
      out.push(...known.customers
        .filter((customer) => fold(customer.name).startsWith(part))
        .map((customer) => `${invoice?.[1] ?? 'fakturer'} ${customer.name}`))
    }
  }
  return [...new Set(out)].slice(0, SHOWN)
}

/** The suggestion with what was typed in plain text and the rest of it muted. */
function Completion({ text, typed, detail }: { text: string; typed: number; detail?: string }) {
  return (
    <>
      {text.slice(0, typed)}
      <span className="text-muted-foreground">{text.slice(typed)}</span>
      {detail && <span className="text-muted-foreground"> · {detail}</span>}
    </>
  )
}

/** Whose invoice a credit note completion is for, since its number alone says little. */
const detailOf = (text: string, known: Known | null) =>
  /^kreditnota\s/.test(text) ? known?.invoices.find((invoice) => `kreditnota ${invoice.number}` === text)?.customer : undefined

export function createSuggestionProvider(recognize: RequestRecognizer = recognizeRequest): PaletteProvider {
  return {
    id: 'suggest',
    // Ahead of the request's own row: while a name or number is half typed, the whole one is the better guess.
    order: 80,
    sections: ({ query, can, t }: PaletteContext) => {
      const section = (known: Known | null): PaletteSection[] => {
        const texts = suggestions(query, known)
        const permitted = permittedRequest(recognize, can)
        const items = texts.flatMap((text): PaletteItem[] => {
          const intent = permitted(text)
          if (!intent) return []
          return [{
            id: `suggest:${text}`,
            label: text,
            icon: REQUEST_ICONS[intent.kind],
            content: <Completion text={text} typed={fold(query).trimStart().length} detail={detailOf(text, known)} />,
            // Choosing it writes it out; the request it reads as then opens as it would typed in full.
            perform: ({ fill }) => fill(text),
            card: texts.length === 1 ? ({ close }) => <RequestCardSlot intent={intent} onDismiss={close} autoFocus={false} /> : undefined,
            prefetch: texts.length === 1 ? () => prefetchRequest(intent) : undefined,
          }]
        })
        return items.length ? [{ id: 'suggest', heading: t('shell.palette.groupSuggest'), items }] : []
      }
      // Opening loads what suggestions are grounded in, so it is there by the time it is needed.
      const known = peekKnown()
      if (known || !grounded(typedOf(query))) {
        if (!known) void loadKnown()
        return section(known)
      }
      return loadKnown().then(section)
    },
  }
}

export const suggestionProvider = createSuggestionProvider()
