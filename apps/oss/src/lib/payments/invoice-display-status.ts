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
