import { formatIsoDate } from "../exports/format"

/**
 * The status badge an invoice shows. Partial payment is tracked in `paymentStatus`, not the
 * lifecycle status, so a sent invoice with some money received reads as "partially paid".
 * Overdue stays overdue: that is the more urgent fact, until a reminder for it has been sent
 * (`reminderSent`, from a reminder job step that succeeded): then it reads "reminder sent".
 *
 * An invoice being sent is still a `draft` row, with its number, until the provider settles the
 * delivery. It reads "sending" meanwhile, never "draft": a failed delivery that gave the number
 * back reads draft again once settled.
 */
export function invoiceDisplayStatus(
  invoice: { status: string; paymentStatus: string; balanceDue: number; dueDate?: string | Date; lastEmailAttemptOutcome?: string | null },
  timezone?: string | null,
  // Lists pass their shared YYYY-MM-DD to avoid formatting the same zoned date for every row.
  now: Date | string = new Date(),
  reminderSent = false
) {
  if (invoice.status === "draft" && invoice.lastEmailAttemptOutcome === "sending") return "sending"
  const status = lifecycleDisplayStatus(invoice, timezone, now)
  // Only an overdue invoice has a reminder to show; once it is paid or credited, that is the news.
  return reminderSent && status === "overdue" ? "reminder_sent" : status
}

function lifecycleDisplayStatus(
  invoice: { status: string; paymentStatus: string; balanceDue: number; dueDate?: string | Date },
  timezone: string | null | undefined,
  now: Date | string
) {
  const collectible = ["sent", "viewed", "overdue"].includes(invoice.status)
  if (collectible && invoice.paymentStatus === "paid") return "paid"
  // Due dates are calendar dates stored at UTC midnight. Compare calendar days, not instants.
  if (collectible && invoice.balanceDue > 0 && invoice.dueDate) {
    const dueDate = new Date(invoice.dueDate)
    const today = typeof now === "string" ? now : formatIsoDate(now, timezone)
    if (Number.isFinite(dueDate.getTime()) && dueDate.toISOString().slice(0, 10) < today) {
      return "overdue"
    }
  }
  if (
    (invoice.status === "sent" || invoice.status === "viewed") &&
    invoice.paymentStatus === "partially_paid"
  ) {
    return "partially_paid"
  }
  return invoice.status
}

/**
 * The rule under an invoice's amount (see `Amount`): none for a draft, one while money is asked
 * for, two once it has arrived. A part payment draws the second rule as far as the settled share
 * of the total, so the rule shows how close the account is to zero.
 *
 * Settled counts what was paid and what was credited: `balanceDue` is what is left of the total
 * after both, so the share comes from the total and the balance alone, whatever `paymentStatus`
 * says: credits without a payment draw it too, and an invoice credited down to nothing is double.
 * The share is a ratio for drawing, not money; it never feeds an amount.
 */
export function invoiceAmountRule(invoice: {
  status: string
  paymentStatus: string
  total: number
  balanceDue: number
}): { rule: "none" | "single" | "double"; paidFraction?: number } {
  if (invoice.status === "draft") return { rule: "none" }
  if (invoice.status === "paid" || invoice.status === "credited" || invoice.paymentStatus === "paid") {
    return { rule: "double" }
  }
  if (invoice.total > 0) {
    const share = Math.min(1, Math.max(0, 1 - invoice.balanceDue / invoice.total))
    if (share >= 1) return { rule: "double" }
    if (share > 0) return { rule: "double", paidFraction: share }
  }
  return { rule: "single" }
}

/** Whole calendar days an invoice is past its due date, as the dashboard counts them. */
export function invoiceDaysOverdue(dueDate: string | Date, timezone?: string | null, now: Date = new Date()): number {
  const due = new Date(dueDate).toISOString().slice(0, 10)
  return Math.max(0, Math.round((Date.parse(formatIsoDate(now, timezone)) - Date.parse(due)) / 86_400_000))
}
