import { Sparkles } from 'lucide-react'

import { trpc } from '../../../trpc/client'
import { prefetchRequest } from '../../command-bar/request-data'
import { RequestCardSlot } from '../../command-bar/request-card-slot'
import { permittedRequest, recognizeRequest } from '../../command-bar/request-intent'
import { loadKnown } from './known'
import { suggestions } from './suggestion-provider'
import type { PaletteContext, PaletteItem, PaletteProvider, PaletteSection } from './types'

/** Waits this long after the last key: the model answers in about 250ms, so the card still comes soon after a pause. */
const DEBOUNCE_MS = 300
/** How sure the model has to be before its answer is offered at all, and before it opens a card by itself. */
const OFFER = 0.6
const OPEN = 0.85

// Known once the capabilities have been read; until then, and where it is off, nothing waits on it.
let enabled: boolean | null = null
let loading: Promise<void> | null = null
const loadEnabled = () =>
  (loading ??= trpc.runtime.capabilities.query().then((value) => { enabled = value.aiInvoiceDraft.requestDecisionsEnabled === true }, () => { enabled = false }))

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(finish, DEBOUNCE_MS)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Hours or pieces as written ("5 timer", "3 stk"), carried into the invoice request the answer becomes. */
function quantity(text: string): string {
  const found = /(\d+(?:[.,]\d+)?)\s*(timer|time|t|stk)(?![\p{L}])/iu.exec(text)
  return found ? ` ${found[1]}${/^stk/i.test(found[2]!) ? ' stk' : 't'}` : ''
}

/**
 * The palette's last resort, for whole sentences nothing else can read ("hvem skylder mig penge",
 * "annuller fakturaen til birk"): a decision model says which request it is and for which customer,
 * and the answer is offered as the request written out. Only for text that nothing local offers
 * anything for, and only where the operator has set the model's key.
 */
export const decisionProvider: PaletteProvider = {
  id: 'decide',
  order: 85,
  sections: (context: PaletteContext) => {
    if (enabled === null) void loadEnabled()
    const text = context.query.trim()
    // A sentence: one word is a search, and anything the parser or the suggestions read is theirs.
    if (!enabled || text.length < 8 || !/\s/.test(text) || recognizeRequest(text) || suggestions(text, null).length) return []
    return decide(text, context)
  },
}

async function decide(text: string, { can, t, signal }: PaletteContext): Promise<PaletteSection[]> {
  await pause(signal)
  if (signal.aborted) return []
  const decision = await trpc.ai.decideRequest.query({ text }, { signal }).catch(() => null)
  if (!decision || signal.aborted || decision.probability < OFFER) return []

  const customer = decision.customer && decision.customer.probability >= 0.4 ? decision.customer.name : null
  const texts =
    decision.kind === 'overdue' ? ['vis forfaldne fakturaer']
    : decision.kind === 'vat' ? ['vis moms']
    : decision.kind === 'invoice' && customer ? [`fakturer ${customer}${quantity(text)}`]
    : decision.kind === 'creditNote' && customer
      ? (await loadKnown()).invoices.filter((invoice) => invoice.customer === customer).slice(0, 3).map((invoice) => `kreditnota ${invoice.number}`)
      : []
  if (signal.aborted) return []

  const permitted = permittedRequest(recognizeRequest, can)
  const lone = texts.length === 1 && decision.probability >= OPEN
  const items = texts.flatMap((written): PaletteItem[] => {
    const intent = permitted(written)
    if (!intent) return []
    return [{
      id: `decide:${written}`,
      label: written,
      icon: Sparkles,
      perform: ({ fill }) => fill(written),
      card: lone ? ({ close }) => <RequestCardSlot intent={intent} onDismiss={close} autoFocus={false} /> : undefined,
      prefetch: lone ? () => prefetchRequest(intent) : undefined,
    }]
  })
  return items.length ? [{ id: 'decide', heading: t('shell.palette.groupSuggest'), items }] : []
}

export function resetDecisionsForTesting(): void {
  enabled = null
  loading = null
}
