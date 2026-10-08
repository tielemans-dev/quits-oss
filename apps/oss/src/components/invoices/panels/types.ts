/** The invoice fields every lifecycle panel on the invoice page receives. */
export type InvoicePanelInvoice = {
  id: string
  number: string | null
  status: string
  paymentStatus: string
  currency: string
  total: number
  /** Sum of payments that are not voided. */
  amountPaid: number
  /** Sum of issued credit notes. */
  amountCredited: number
  /** What the customer still owes after payments and credit notes. */
  balanceDue: number
  dueDate: string
  contact: { id: string; name: string; email: string | null }
}

export type InvoicePanelProps = {
  invoice: InvoicePanelInvoice
  locale?: string | null
  /** Reload the invoice after a panel changes it. */
  onChanged: () => Promise<void>
}
