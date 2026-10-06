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
