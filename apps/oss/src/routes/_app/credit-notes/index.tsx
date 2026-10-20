import { useAppQuery } from "../../../hooks/use-query-refresh"
import { QueryError } from "../../../components/query-state"
import { createFileRoute } from "@tanstack/react-router"
import { trpc } from "../../../trpc/client"
import { useI18n } from "../../../lib/i18n/react"
import { CreditNotesList } from "../../../components/credit-notes/credit-notes-list"
import { ListEmpty, ListSkeleton } from "../../../components/kvit/list"
import { PageHeader } from "../../../components/kvit/page-header"
import type { CreditNoteListItem } from "../../../components/credit-notes/types"

/** Owned by the credit notes feature. */
export const Route = createFileRoute("/_app/credit-notes/")({
  component: CreditNotesPage,
})

function CreditNotesPage() {
  const { t } = useI18n()
  const list = useAppQuery(["creditNotes"], () => trpc.creditNotes.list.query())
  const creditNotes: CreditNoteListItem[] = list.data ?? []
  const loading = list.loading
  if (list.error) return <QueryError error={list.error} retry={list.refresh} />

  return (
    <div>
      <PageHeader title={t("creditNotes.title")} />

      {loading ? (
        <ListSkeleton label={t("creditNotes.loading")} bleed />
      ) : creditNotes.length === 0 ? (
        <ListEmpty
          title={t("creditNotes.empty.title")}
          description={t("creditNotes.empty.description")}
        />
      ) : (
        <CreditNotesList creditNotes={creditNotes} />
      )}
    </div>
  )
}
