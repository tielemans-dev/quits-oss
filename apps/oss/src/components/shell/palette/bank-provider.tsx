import { Check, Landmark } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { formatCurrency } from '../../../lib/i18n/format'
import { useI18n } from '../../../lib/i18n/react'
import { matchPayment, parseAmountMinor, type Candidate, type IncomingPayment, type MatchInvoice } from '../../../lib/payments/payment-match'
import { cn } from '../../../lib/utils'
import { trpc } from '../../../trpc/client'
import { readInvoices } from '../../command-bar/request-data'
import { stagger } from '../../command-bar/request-card-slot'
import { previewRequest } from '../../command-bar/request-preview'
import { recognizeRequest } from '../../command-bar/request-intent'
import { Button } from '../../ui/button'
import type { PaletteContext, PaletteProvider, PaletteSection } from './types'

/** How a pasted block's lines are kept apart in the one-line field (see the palette's paste handler). */
export const LINE_BREAK = ' ⏎ '

const AMOUNT = /(?<![\d.,])(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})(?![\d,])/g
const DATE = /\b\d{1,2}[.-]\d{1,2}[.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g

export type Line = { text: string; payment: IncomingPayment; match: Candidate | null }

/**
 * A line from a bank statement: the last amount with øre in it is what came in, the rest names who
 * paid and why. "16.10.2026 Overførsel Birk Arkitekter ApS INV-2026-001 18.500,00". Money going
 * out (a minus in front) is not a payment received.
 */
export function readBankLine(text: string): IncomingPayment | null {
  const amounts = [...text.matchAll(AMOUNT)]
  const last = amounts.at(-1)
  if (!last || text.slice(0, last.index).trimEnd().endsWith('-')) return null
  const amountMinor = parseAmountMinor(last[0])
  const rest = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).replace(DATE, ' ').replace(/\s+/g, ' ').trim()
  if (!amountMinor || !/\p{L}{3}/u.test(rest)) return null
  return { payer: rest, amountMinor, currency: 'DKK', reference: rest }
}

const best = (payment: IncomingPayment, invoices: readonly MatchInvoice[]): Candidate | null => {
  const match = matchPayment(payment, invoices)
  return match.kind === 'exact' ? match.candidate : match.kind === 'shortlist' ? match.candidates[0]! : null
}

/**
 * Bank lines pasted into the field become payments matched to the invoices they pay, all in one
 * card: tick off what is right, then one click records them. Lines nothing matches are shown and
 * left alone.
 */
export const bankProvider: PaletteProvider = {
  id: 'bank',
  order: 75,
  sections: ({ query, can, t }: PaletteContext) => {
    if (!can('payment:create') || recognizeRequest(query)) return []
    const texts = query.split(LINE_BREAK).map((line) => line.trim()).filter(Boolean)
    const payments = texts.map(readBankLine)
    if (!texts.length || payments.some((payment) => !payment)) return []
    return readInvoices().then(({ invoices }): PaletteSection[] => {
      const listed = invoices as unknown as MatchInvoice[]
      const lines = texts.map((text, index) => ({ text, payment: payments[index]!, match: best(payments[index]!, listed) }))
      // One line on its own has to match something to be taken for a bank line rather than a search.
      if (lines.length === 1 && !lines[0]!.match) return []
      return [{
        id: 'bank',
        heading: t('shell.palette.groupBank'),
        items: [{
          id: `bank:${query}`,
          label: t('shell.bank.title', { count: lines.length }),
          icon: Landmark,
          perform: () => undefined,
          card: ({ close }) => <BankCard lines={lines} onDismiss={close} />,
        }],
      }]
    }, () => [])
  },
}

export function BankCard({ lines, onDismiss }: { lines: Line[]; onDismiss: () => void }) {
  const { t, locale } = useI18n()
  const [ticked, setTicked] = useState(() => new Set(lines.flatMap((line, index) => (line.match ? [index] : []))))
  const [pending, setPending] = useState(false)
  const [recorded, setRecorded] = useState<string[] | null>(null)
  const [undone, setUndone] = useState(false)
  const chosen = useMemo(() => lines.filter((line, index) => line.match && ticked.has(index)), [lines, ticked])
  const today = new Date().toISOString().slice(0, 10)
  const paying = recorded ? '' : chosen.map((line) => line.match!.invoice.id).join(',')
  useEffect(() => { previewRequest(paying ? { kind: 'paid', invoiceIds: paying.split(',') } : null) }, [paying])
  useEffect(() => () => previewRequest(null), [])

  async function record() {
    if (pending || !chosen.length) return
    setPending(true)
    const ids: string[] = []
    try {
      for (const line of chosen) {
        const result = await trpc.payments.record.mutate({
          invoiceId: line.match!.invoice.id, amount: line.payment.amountMinor / 100, paidAt: today, method: 'bank_transfer',
          reference: line.text.slice(0, 200), requestId: crypto.randomUUID(),
        })
        ids.push(result.payment.id)
      }
    } finally {
      setPending(false)
      setRecorded(ids)
    }
  }

  async function undo() {
    for (const paymentId of recorded ?? []) await trpc.payments.void.mutate({ paymentId, reason: t('shell.request.payment.undoReason') }).catch(() => {})
    setUndone(true)
  }

  if (recorded) {
    return (
      <div role="status" className="request-stagger flex items-center gap-3 p-5">
        <span {...stagger(0)} className="bg-tone-success/15 text-tone-success flex size-9 shrink-0 items-center justify-center rounded-full"><Check className="size-5" aria-hidden="true" /></span>
        <p {...stagger(1)} className="flex-1 font-semibold">{undone ? t('shell.bank.undone') : t('shell.bank.done', { count: recorded.length })}</p>
        {!undone && <Button {...stagger(2)} type="button" variant="outline" onClick={() => void undo()}>{t('shell.bank.undo')}</Button>}
      </div>
    )
  }

  return (
    <div className="request-stagger space-y-3 p-4">
      <p {...stagger(0)} className="font-semibold">{t('shell.bank.title', { count: lines.length })}</p>
      <ul {...stagger(1)} className="divide-hairline divide-y text-sm">
        {lines.map((line, index) => (
          <li key={index} className={cn('flex items-center gap-3 py-2', !line.match && 'opacity-60')}>
            <input
              type="checkbox"
              disabled={!line.match}
              checked={ticked.has(index)}
              onChange={() => setTicked((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next })}
              aria-label={line.text}
              className="accent-foreground size-4 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate">{line.payment.payer}</p>
              <p className="text-muted-foreground truncate text-xs">
                {line.match ? `→ ${line.match.invoice.number} · ${line.match.invoice.contact.name}` : t('shell.bank.unmatched')}
              </p>
            </div>
            <span className="tabular-nums">{formatCurrency(line.payment.amountMinor / 100, 'DKK', locale)}</span>
          </li>
        ))}
      </ul>
      <div {...stagger(2)} className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDismiss} className="transition-[color,background-color,box-shadow]">{t('shell.request.dismiss')}</Button>
        <Button data-primary type="button" disabled={pending || !chosen.length} onClick={() => void record()} className="transition-[color,background-color,box-shadow]">
          {t('shell.bank.confirm', { count: chosen.length })}
        </Button>
      </div>
    </div>
  )
}
