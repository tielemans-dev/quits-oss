import { near, normalize } from '../../../lib/request-parser'
import { trpc } from '../../../trpc/client'
import { prefetchRequest } from '../../command-bar/request-data'
import { RequestCardSlot } from '../../command-bar/request-card-slot'
import { permittedRequest, recognizeRequest } from '../../command-bar/request-intent'
import { loadKnown, peekKnown, type Known } from './known'
import { REQUEST_ICONS, RequestRow } from './request-row'
import { suggestions } from './suggestion-provider'
import type { PaletteContext, PaletteItem, PaletteProvider, PaletteSection } from './types'

/** Waits this long after the last key. A call costs next to nothing; a late card costs the moment. */
const DEBOUNCE_MS = 100
/** How sure the model has to be before its answer is offered at all, and before it opens a card by itself. */
const OFFER = 0.6
const OPEN = 0.85
/** Rows offered for one answer: a customer's invoices to credit, or customers with the same first name. */
const SHOWN = 3

type Decision = { kind: string; probability: number }

// Known once the capabilities have been read; until then, and where it is off, nothing waits on it.
let enabled: boolean | null = null
let loading: Promise<void> | null = null
const loadEnabled = () =>
  (loading ??= trpc.runtime.capabilities.query().then((value) => { enabled = value.aiInvoiceDraft.requestDecisionsEnabled === true }, () => { enabled = false }))

// Answers for what was typed lately, so typing back to a sentence does not ask again.
const answers = new Map<string, Decision | null>()
function remember(text: string, decision: Decision | null) {
  answers.delete(text)
  answers.set(text, decision)
  if (answers.size > 50) answers.delete(answers.keys().next().value!)
}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(finish, DEBOUNCE_MS)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * The customers a sentence names, best first: the whole name, its first word, or a word one letter
 * off it or the start of it ("havblik", "hablik", "studi"). Found here, so names never leave the app.
 */
export function customersIn(text: string, customers: Known['customers']): string[] {
  const typed = ` ${normalize(text)} `
  const words = typed.trim().split(' ').filter((word) => word.length >= 3)
  const scored = customers.map(({ name }) => {
    const whole = normalize(name)
    const first = whole.split(' ')[0] ?? ''
    const score = typed.includes(` ${whole} `) ? 3
      : words.includes(first) ? 2
      : words.some((word) => near(word, first) || (word.length >= 4 && first.startsWith(word))) ? 1
      : 0
    return { name, score }
  })
  const best = Math.max(0, ...scored.map((entry) => entry.score))
  return best ? scored.filter((entry) => entry.score === best).map((entry) => entry.name) : []
}

const NUMBER = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?`

/** Hours or pieces and a price as written ("5 timer à 800 kr", "5000 kr"), carried into the invoice request. */
function line(text: string): string {
  const quantity = /(\d+(?:[.,]\d+)?)\s*(timer|time|hours?|t|h|stk|pcs)(?![\p{L}])/iu.exec(text)
  const price = new RegExp(String.raw`(${NUMBER})\s*kr\.?(?![\p{L}])`, 'iu').exec(text)
  const amount = price ? `${price[1]} kr` : ''
  if (!quantity) return amount ? ` ${amount}` : ''
  return ` ${quantity[1]}${/^(?:stk|pcs)/i.test(quantity[2]!) ? ' stk' : 't'}${amount ? ` à ${amount}` : ''}`
}

/** 12500.5 as "12.500,50", the way the payment request is written. */
function kroner(amount: number): string {
  const [whole, fraction] = amount.toFixed(2).split('.')
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return fraction === '00' ? grouped : `${grouped},${fraction}`
}

const issued = (invoice: Known['invoices'][number]) => invoice.status !== 'draft' && invoice.status !== 'void'

/**
 * The answer written out as requests the person could have typed. With nothing to name, the start of
 * one: choosing it leaves the person to pick the customer or invoice from the suggestions.
 */
export function writtenRequests(kind: string, text: string, known: Known): { requests: string[]; start?: string } {
  const names = customersIn(text, known.customers)
  switch (kind) {
    case 'overdue': return { requests: ['vis forfaldne fakturaer'] }
    case 'vat': return { requests: ['vis moms'] }
    case 'invoice':
      return names.length ? { requests: names.slice(0, SHOWN).map((name) => `fakturer ${name}${line(text)}`) } : { requests: [], start: 'fakturer ' }
    case 'creditNote': {
      const invoices = known.invoices.filter((invoice) => names.includes(invoice.customer) && issued(invoice))
      return invoices.length ? { requests: invoices.slice(0, SHOWN).map((invoice) => `kreditnota ${invoice.number}`) } : { requests: [], start: 'kreditnota ' }
    }
    case 'payment': {
      if (names.length !== 1) return { requests: [] }
      const written = new RegExp(String.raw`(${NUMBER})\s*kr`, 'iu').exec(text)
      if (written) return { requests: [`betaling modtaget fra ${names[0]} ${written[1]} kr`] }
      // No amount: what that customer still owes, one row per invoice.
      const open = known.invoices.filter((invoice) => invoice.customer === names[0] && issued(invoice) && invoice.balanceDue > 0 && invoice.currency === 'DKK')
      return { requests: open.slice(0, SHOWN).map((invoice) => `betaling modtaget fra ${names[0]} ${kroner(invoice.balanceDue)} kr ref ${invoice.number}`) }
    }
    case 'customer': {
      const cvr = /(?<!\d)\d{8}(?!\d)/.exec(text.replace(/(\d)\s(?=\d)/g, '$1'))
      // "kunder" alone reads to the model as a new customer; listing them is search.
      if (cvr) return { requests: [`cvr ${cvr[0]}`] }
      return /\b(?:ny|nye|opret|tilføj)\b/iu.test(text) ? { requests: ['ny kunde'] } : { requests: [] }
    }
    default: return { requests: [] }
  }
}

/**
 * The palette's last resort, for whole sentences nothing else can read ("hvem skylder mig penge",
 * "annuller fakturaen til birk"): a decision model says which request it is, the customer is found
 * here, and the answer is offered as the request written out. Only for text that nothing local
 * offers anything for, and only where the operator has set the model's key.
 */
export const decisionProvider: PaletteProvider = {
  id: 'decide',
  order: 85,
  sections: (context: PaletteContext) => {
    if (enabled === null) void loadEnabled()
    const text = context.query.trim()
    // A sentence: one word is a search, and anything the parser or the suggestions read is theirs.
    if (!enabled || text.length < 8 || !/\s/.test(text) || recognizeRequest(text) || suggestions(text, null).length) return []
    const known = peekKnown()
    if (!known) void loadKnown()
    // Asked before: answered in the same render, so the card is back the moment the text is.
    if (answers.has(text) && known) return offer(text, answers.get(text)!, known, context)
    return decide(text, context)
  },
}

async function decide(text: string, context: PaletteContext): Promise<PaletteSection[]> {
  const { signal } = context
  if (!answers.has(text)) {
    await pause(signal)
    if (signal.aborted) return []
    const decision = await trpc.ai.decideRequest.query({ text }, { signal }).catch(() => undefined)
    if (signal.aborted || decision === undefined) return []
    remember(text, decision)
  }
  const known = await loadKnown()
  return signal.aborted ? [] : offer(text, answers.get(text) ?? null, known, context)
}

function offer(text: string, decision: Decision | null, known: Known, { can, t }: PaletteContext): PaletteSection[] {
  if (!decision || decision.probability < OFFER) return []
  const { requests, start } = writtenRequests(decision.kind, text, known)
  const permitted = permittedRequest(recognizeRequest, can)
  const lone = requests.length === 1 && decision.probability >= OPEN
  const items = requests.flatMap((written): PaletteItem[] => {
    const intent = permitted(written)
    if (!intent) return []
    // Its reads start now, not when the card is chosen, so it opens with its figures.
    if (lone) prefetchRequest(intent)
    return [{
      id: `decide:${written}`,
      label: written,
      icon: REQUEST_ICONS[intent.kind],
      content: <RequestRow intent={intent} known={known} t={t} />,
      perform: ({ fill }) => fill(written),
      card: lone ? ({ close }) => <RequestCardSlot intent={intent} onDismiss={close} autoFocus={false} /> : undefined,
    }]
  })
  const startKind = start === 'fakturer ' ? 'invoice' : 'creditNote'
  if (start && can(startKind === 'invoice' ? 'invoice:create' : 'creditNote:create')) {
    items.push({
      id: `decide:${start}`,
      label: `${start}…`,
      icon: REQUEST_ICONS[startKind],
      content: <span className="flex items-baseline gap-2"><span className="font-medium">{t(`shell.request.title.${startKind}`)}</span><span className="text-muted-foreground">{start}…</span></span>,
      perform: ({ fill }) => fill(start),
    })
  }
  return items.length ? [{ id: 'decide', heading: t('shell.palette.groupSuggest'), items }] : []
}

export function resetDecisionsForTesting(): void {
  enabled = null
  loading = null
  answers.clear()
}
