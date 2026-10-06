import { createFileRoute } from "@tanstack/react-router"

/** Owned by the recurring invoices feature. */
export const Route = createFileRoute("/_app/recurring/")({
  component: RecurringInvoicesPage,
})

function RecurringInvoicesPage() {
  return null
}
