import { formatIsoDate } from "../../lib/exports/format"

/** How many of a customer's latest invoices are read, and how many in a row must agree. */
export const LEARN_WINDOW = 3
export const LEARN_MIN_STREAK = 2

export type PastInvoiceTerms = { issueDate: Date; dueDate: Date; timezone: string }

/** Calendar days from the issue date (in the invoice's time zone) to the due date. */
export function paymentTermsDays({ issueDate, dueDate, timezone }: PastInvoiceTerms): number {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
  return Math.round((day(dueDate.toISOString().slice(0, 10)) - day(formatIsoDate(issueDate, timezone))) / 86_400_000)
}

export type LearnedPaymentTerms = { days: number; count: number }

/**
 * The payment terms a customer's last invoices agree on, newest first. A default needs the same
 * value on the latest 2 or 3; a newer invoice with a different value ends the run, which resets it.
 * Terms equal to the organization's own default are not news, and a cleared value stays cleared
 * until a different one is learned.
 */
export function learnPaymentTerms(
  newestFirst: PastInvoiceTerms[],
  orgDefaultDays: number | null | undefined,
  clearedDays?: number | null
): LearnedPaymentTerms | null {
  const days = newestFirst.slice(0, LEARN_WINDOW).map(paymentTermsDays)
  const latest = days[0]
  if (latest === undefined || latest < 0) return null
  const count = days.findIndex(value => value !== latest)
  const streak = count === -1 ? days.length : count
  if (streak < LEARN_MIN_STREAK || latest === orgDefaultDays || latest === clearedDays) return null
  return { days: latest, count: streak }
}
