import { getCurrencyExponent } from "@quits/shared/currency"

import { invoiceDaysOverdue, invoiceDisplayStatus } from "../../lib/payments/invoice-display-status"

/** One job takes at most this many invoices (`queueReminderJob`). */
export const MAX_BATCH = 100

export type Invoice = {
  id: string
  number: string | null
  status: string
  paymentStatus: string
  dueDate: string
  balanceDue: number
  currency: string
  contact: { name: string }
}

/** Sums in minor units, so that the figure shown is exact; one total per currency. */
export function totalsByCurrency(invoices: readonly Invoice[]) {
  const sums = new Map<string, number>()
  for (const invoice of invoices) {
    const exponent = getCurrencyExponent(invoice.currency) ?? 2
    sums.set(invoice.currency, (sums.get(invoice.currency) ?? 0) + Math.round(invoice.balanceDue * 10 ** exponent))
  }
  return [...sums].map(([currency, minor]) => ({ currency, amount: minor / 10 ** (getCurrencyExponent(currency) ?? 2) }))
}

/**
 * The invoices the Fakturaer list shows as overdue (same status function, same reminded set), the
 * oldest first. The overdue card and the morning summary both read this, so they cannot disagree.
 */
export function overdueInvoices(invoices: readonly Invoice[], timezone: string | null, reminded: ReadonlySet<string>) {
  return invoices
    .filter(invoice => invoiceDisplayStatus(invoice, timezone, undefined, reminded.has(invoice.id)) === "overdue")
    .map(invoice => ({ invoice, days: invoiceDaysOverdue(invoice.dueDate, timezone) }))
    .sort((a, b) => b.days - a.days)
}
