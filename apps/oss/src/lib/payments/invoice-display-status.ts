/**
 * The status badge an invoice shows. Partial payment is tracked in `paymentStatus`, not the
 * lifecycle status, so a sent invoice with some money received reads as "partially paid".
 * Overdue stays overdue: that is the more urgent fact.
 */
export function invoiceDisplayStatus(invoice: { status: string; paymentStatus: string }) {
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
 * after both. The share is a ratio for drawing, not money; it never feeds an amount.
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
  if (invoice.paymentStatus === "partially_paid") {
    const share = invoice.total > 0 ? 1 - invoice.balanceDue / invoice.total : 0
    return { rule: "double", paidFraction: Math.min(1, Math.max(0, share)) }
  }
  return { rule: "single" }
}
