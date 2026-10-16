import { Banknote, Clock, FileMinus, FilePlus, Percent, Repeat, UserPlus, type LucideIcon } from 'lucide-react'

import { parsePaymentRequest } from '../../../lib/payments/payment-match'
import { creditNumber } from '../../command-bar/request-data'
import type { RequestIntent } from '../../command-bar/request-intent'
import type { Known } from './known'
import type { PaletteContext } from './types'

/** What each kind of request does, at a glance in a list of them. */
export const REQUEST_ICONS: Record<RequestIntent['kind'], LucideIcon> = {
  overdue: Clock,
  invoice: FilePlus,
  repeat: Repeat,
  creditNote: FileMinus,
  payment: Banknote,
  customer: UserPlus,
  vat: Percent,
}

/**
 * The particulars of a request, read back from how it is written: "Havblik Design 5t",
 * "INV-2026-001 · Birk Arkitekter", "Birk Arkitekter · 18.500 kr · INV-2026-001".
 */
export function requestDetail(intent: RequestIntent, known: Known | null): string {
  const text = intent.input.trim()
  switch (intent.kind) {
    case 'invoice':
    case 'repeat':
      return text.replace(/^(?:faktura\s+til|fakturer)\s*/iu, '')
    case 'creditNote': {
      const number = creditNumber(text)
      return [number, known?.invoices.find((invoice) => invoice.number === number)?.customer].filter(Boolean).join(' · ')
    }
    case 'payment': {
      const payment = parsePaymentRequest(text)
      const amount = /(\d[\d.,]*)\s*kr/iu.exec(text)?.[1]
      return payment ? [payment.payer, amount && `${amount} kr`, payment.reference].filter(Boolean).join(' · ') : text
    }
    case 'customer': {
      const cvr = /\d{8}/.exec(text)?.[0]
      return cvr ? `CVR ${cvr}` : ''
    }
    default:
      return ''
  }
}

/** A request as a row: what it is, then what it is about, so a list of them reads at a glance. */
export function RequestRow({ intent, known, t }: { intent: RequestIntent; known: Known | null; t: PaletteContext['t'] }) {
  const detail = requestDetail(intent, known)
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 font-medium">{t(`shell.request.title.${intent.kind}`)}</span>
      {detail && <span className="text-muted-foreground min-w-0 truncate tabular-nums">{detail}</span>}
    </span>
  )
}
