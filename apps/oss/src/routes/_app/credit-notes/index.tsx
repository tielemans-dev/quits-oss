import { createFileRoute } from "@tanstack/react-router"

/** Owned by the credit notes feature. */
export const Route = createFileRoute("/_app/credit-notes/")({
  component: CreditNotesPage,
})

function CreditNotesPage() {
  return null
}
