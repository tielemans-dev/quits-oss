/** The invoice fields every lifecycle panel on the invoice page receives. */
export type InvoicePanelInvoice = {
  id: string
  number: string
  status: string
  paymentStatus: string
  currency: string
  total: number
  dueDate: string
  contact: { id: string; name: string; email: string | null }
}

export type InvoicePanelProps = {
  invoice: InvoicePanelInvoice
  locale?: string | null
  /** Reload the invoice after a panel changes it. */
  onChanged: () => Promise<void>
}
