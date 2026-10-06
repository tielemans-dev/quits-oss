import { createFileRoute } from "@tanstack/react-router"

/** Owned by the credit notes feature. */
export const Route = createFileRoute("/_app/credit-notes/$creditNoteId")({
  component: CreditNoteDetailPage,
})

function CreditNoteDetailPage() {
  return null
}
