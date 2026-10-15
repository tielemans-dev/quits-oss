import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { onRequestDone } from "../../../components/command-bar/request-events"
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
  const [creditNotes, setCreditNotes] = useState<CreditNoteListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let latest = 0
    const load = () => { const request = ++latest; return trpc.creditNotes.list
      .query()
      .then(notes => { if (request === latest) setCreditNotes(notes) })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t("creditNotes.error.generic"))
      )
      .finally(() => setLoading(false)) }
    void load()
    return onRequestDone(done => { if (done.kind === "creditNote") void load() })
  }, [t])

  return (
    <div className="p-6">
      <PageHeader title={t("creditNotes.title")} />

      {error && (
        <p className="text-sm text-destructive mb-4" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <ListSkeleton label={t("creditNotes.loading")} />
      ) : creditNotes.length === 0 && !error ? (
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
