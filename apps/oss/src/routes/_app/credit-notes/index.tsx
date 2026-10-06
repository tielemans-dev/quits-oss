import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { FileMinus } from "lucide-react"
import { trpc } from "../../../trpc/client"
import { useI18n } from "../../../lib/i18n/react"
import { CreditNotesTable } from "../../../components/credit-notes/credit-notes-table"
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
    trpc.creditNotes.list
      .query()
      .then(setCreditNotes)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t("creditNotes.error.generic"))
      )
      .finally(() => setLoading(false))
  }, [t])

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{t("creditNotes.title")}</h1>
      </div>

      {error && (
        <p className="text-sm text-destructive mb-4" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-muted-foreground">{t("creditNotes.loading")}</p>
      ) : creditNotes.length === 0 && !error ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FileMinus className="size-12 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold mb-1">{t("creditNotes.empty.title")}</h2>
          <p className="text-muted-foreground">{t("creditNotes.empty.description")}</p>
        </div>
      ) : (
        <CreditNotesTable creditNotes={creditNotes} />
      )}
    </div>
  )
}
