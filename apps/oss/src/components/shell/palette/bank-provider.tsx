import { Check, Landmark } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { formatIsoDate } from '../../../lib/exports/format'
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

/**
 * A pasted line: the payment, the date the bank booked it (null when the line has none), and the
 * invoices it could pay. `exact` says the match is certain; otherwise the user picks from the
 * candidates before the line can be recorded.
 */
export type Line = { text: string; payment: IncomingPayment; paidOn: string | null; candidates: Candidate[]; exact: boolean }

/** The booking date in a bank line ("16.10.2026", "16-10-26", "2026-10-16") as an ISO date, or null. */
export function readBankDate(text: string): string | null {
  const found = text.match(DATE)?.[0]
  if (!found) return null
  const [a, b, c] = found.split(/[.-]/).map(Number) as [number, number, number]
  const [year, month, day] = found.includes('-') && String(a).length === 4 ? [a, b, c] : [c < 100 ? 2000 + c : c, b, a]
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString().slice(0, 10)
}

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

function readLine(text: string, payment: IncomingPayment, invoices: readonly MatchInvoice[]): Line {
  const match = matchPayment(payment, invoices)
  const candidates = match.kind === 'exact' ? [match.candidate] : match.kind === 'shortlist' ? match.candidates : []
  return { text, payment, paidOn: readBankDate(text), candidates, exact: match.kind === 'exact' }
}

/**
 * Bank lines pasted into the field become payments matched to the invoices they pay, all in one
 * card: tick off what is right, then one click records them. Only a certain match is ticked; a line
 * that could pay more than one invoice waits for the user to pick one. Lines nothing matches are
 * shown and left alone.
 */
export const bankProvider: PaletteProvider = {
  id: 'bank',
  order: 75,
  sections: ({ query, can, t }: PaletteContext) => {
    if (!can('payment:create') || recognizeRequest(query)) return []
    const texts = query.split(LINE_BREAK).map((line) => line.trim()).filter(Boolean)
    const payments = texts.map(readBankLine)
    if (!texts.length || payments.some((payment) => !payment)) return []
    return readInvoices().then(({ invoices, timezone }): PaletteSection[] => {
      const listed = invoices as unknown as MatchInvoice[]
      const lines = texts.map((text, index) => readLine(text, payments[index]!, listed))
      // One line on its own has to match something to be taken for a bank line rather than a search.
      if (lines.length === 1 && !lines[0]!.candidates.length) return []
      return [{
        id: 'bank',
        heading: t('shell.palette.groupBank'),
        items: [{
          id: `bank:${query}`,
          label: t('shell.bank.title', { count: lines.length }),
          icon: Landmark,
          perform: () => undefined,
          // Keyed by the paste, so a new batch starts a new card rather than showing the last one's result.
          card: ({ close }) => <BankCard key={query} lines={lines} today={formatIsoDate(new Date(), timezone)} canVoid={can('payment:void')} onDismiss={close} />,
        }],
      }]
    }, () => [])
  },
}

export function BankCard({ lines, today, canVoid, onDismiss }: { lines: Line[]; today: string; canVoid: boolean; onDismiss: () => void }) {
  const { t, locale } = useI18n()
  const [picked, setPicked] = useState(() => new Map(lines.flatMap((line, index) => (line.exact ? [[index, line.candidates[0]!.invoice.id] as const] : []))))
  const [ticked, setTicked] = useState(() => new Set(lines.flatMap((line, index) => (line.exact ? [index] : []))))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Lines recorded so far, by line, so a batch that stops halfway can be finished without recording any line twice.
  const [recorded, setRecorded] = useState<Map<number, string>>(() => new Map())
  const [finished, setFinished] = useState(false)
  const [undone, setUndone] = useState(false)
  const requestIds = useRef(new Map<number, string>())
  const chosen = useMemo(() => lines.flatMap((line, index) => {
    const candidate = line.candidates.find((c) => c.invoice.id === picked.get(index))
    return candidate && ticked.has(index) && !recorded.has(index) ? [{ index, line, candidate }] : []
  }), [lines, picked, ticked, recorded])
  const paying = finished ? '' : chosen.map(({ candidate }) => candidate.invoice.id).join(',')
  useEffect(() => { previewRequest(paying ? { kind: 'paid', invoiceIds: paying.split(',') } : null) }, [paying])
  useEffect(() => () => previewRequest(null), [])

  async function record() {
    if (pending || !chosen.length) return
    setPending(true)
    setError(null)
    const done = new Map(recorded)
    try {
      for (const { index, line, candidate } of chosen) {
        if (!requestIds.current.has(index)) requestIds.current.set(index, crypto.randomUUID())
        // The day the bank booked it, never later than today; a line without a date came in today.
        const paidAt = line.paidOn && line.paidOn < today ? line.paidOn : today
        const result = await trpc.payments.record.mutate({
          invoiceId: candidate.invoice.id, amount: line.payment.amountMinor / 100, paidAt, method: 'bank_transfer',
          reference: line.text.slice(0, 200), requestId: requestIds.current.get(index)!,
        })
        done.set(index, result.payment.id)
        setRecorded(new Map(done))
      }
      setFinished(true)
    } catch {
      setError(t('shell.request.payment.error.record'))
    } finally {
      setPending(false)
    }
  }

  async function undo() {
    if (pending) return
    setPending(true)
    setError(null)
    const left = new Map(recorded)
    for (const [index, paymentId] of recorded) {
      try {
        await trpc.payments.void.mutate({ paymentId, reason: t('shell.request.payment.undoReason') })
        left.delete(index)
      } catch { /* stays recorded, and the card says so */ }
    }
    setRecorded(left)
    setPending(false)
    if (left.size) setError(t('shell.request.payment.error.undo'))
    else setUndone(true)
  }

  if (finished) {
    return (
      <div role="status" className="request-stagger flex flex-wrap items-center gap-3 p-5">
        <span {...stagger(0)} className="bg-tone-success/15 text-tone-success flex size-9 shrink-0 items-center justify-center rounded-full"><Check className="size-5" aria-hidden="true" /></span>
        <p {...stagger(1)} className="flex-1 font-semibold">{undone ? t('shell.bank.undone') : t('shell.bank.done', { count: recorded.size })}</p>
        {!undone && canVoid && <Button {...stagger(2)} type="button" variant="outline" disabled={pending} onClick={() => void undo()}>{t('shell.bank.undo')}</Button>}
        {error && <p role="alert" className="text-destructive w-full text-sm">{error}</p>}
      </div>
    )
  }

  return (
    <div className="request-stagger space-y-3 p-4">
      <p {...stagger(0)} className="font-semibold">{t('shell.bank.title', { count: lines.length })}</p>
      <ul {...stagger(1)} className="divide-hairline divide-y text-sm">
        {lines.map((line, index) => {
          const candidate = line.candidates.find((c) => c.invoice.id === picked.get(index))
          const isRecorded = recorded.has(index)
          return (
            <li key={index} className={cn('flex items-center gap-3 py-2', !line.candidates.length && 'opacity-60')}>
              <input
                type="checkbox"
                disabled={!candidate || isRecorded || pending}
                checked={isRecorded || ticked.has(index)}
                onChange={() => setTicked((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next })}
                aria-label={line.text}
                className="accent-foreground size-4 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate">{line.payment.payer}</p>
                {isRecorded ? (
                  <p className="text-tone-success truncate text-xs">{t('shell.bank.recorded')}</p>
                ) : line.exact ? (
                  <p className="text-muted-foreground truncate text-xs">{`→ ${candidate!.invoice.number} · ${candidate!.invoice.contact.name}`}</p>
                ) : line.candidates.length ? (
                  <select
                    aria-label={t('shell.bank.pick', { payer: line.payment.payer })}
                    value={picked.get(index) ?? ''}
                    disabled={pending}
                    onChange={(event) => {
                      const id = event.target.value
                      setPicked((current) => new Map(current).set(index, id))
                      setTicked((current) => new Set(current).add(index))
                    }}
                    className="text-muted-foreground mt-0.5 max-w-full rounded-sm bg-transparent text-xs"
                  >
                    <option value="" disabled>{t('shell.bank.pickPlaceholder', { count: line.candidates.length })}</option>
                    {line.candidates.map((c) => <option key={c.invoice.id} value={c.invoice.id}>{`${c.invoice.number} · ${c.invoice.contact.name}`}</option>)}
                  </select>
                ) : (
                  <p className="text-muted-foreground truncate text-xs">{t('shell.bank.unmatched')}</p>
                )}
              </div>
              <span className="tabular-nums">{formatCurrency(line.payment.amountMinor / 100, 'DKK', locale)}</span>
            </li>
          )
        })}
      </ul>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <div {...stagger(2)} className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={onDismiss} className="transition-[color,background-color,box-shadow]">{t('shell.request.dismiss')}</Button>
        <Button data-primary type="button" disabled={pending || !chosen.length} onClick={() => void record()} className="transition-[color,background-color,box-shadow]">
          {t('shell.bank.confirm', { count: chosen.length })}
        </Button>
      </div>
    </div>
  )
}
