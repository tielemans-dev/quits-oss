import { useQueryRefresh } from "../../../hooks/use-query-refresh"
import { QueryError, QuerySkeleton } from "../../query-state"
import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { FileMinus } from "lucide-react"
import { trpc } from "../../../trpc/client"
import { useActiveOrganizationId } from "../../../lib/active-organization"
import { formatCurrency } from "../../../lib/i18n/format"
import { useI18n } from "../../../lib/i18n/react"
import { Button } from "../../ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card"
import { onRequestDone } from "../../command-bar/request-events"
import { CreateCreditNoteDialog } from "../../credit-notes/create-credit-note-dialog"
import { CreditNotesTable } from "../../credit-notes/credit-notes-table"
import type { CreditNoteListItem } from "../../credit-notes/types"
import type { InvoicePanelProps } from "./types"

/** Owned by the credit notes feature. */
export function InvoiceCreditNotesPanel({ invoice, locale, onChanged }: InvoicePanelProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [creditNotes, setCreditNotes] = useState<CreditNoteListItem[] | null>(null)
  const [canCreate, setCanCreate] = useState(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [denied, setDenied] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  // Keyed on the active organization so capabilities refresh after switching organization.
  const organizationId = useActiveOrganizationId()
  const latestLoad = useRef(0)

  const load = useCallback(async () => {
    const request = ++latestLoad.current
    setLoadError(null)
    try {
      const [list, capabilities] = await Promise.all([
        trpc.creditNotes.list.query({ invoiceId: invoice.id }),
        trpc.creditNotes.capabilities.query(),
      ])
      // A late answer from before an organization switch must not restore old rights.
      if (request !== latestLoad.current) return
      setCreditNotes(list)
      setDenied(false)
      setCanCreate(capabilities.canCreate)
    } catch (failure) {
      if (request !== latestLoad.current) return
      const code = (failure as { data?: { code?: string } } | null)?.data?.code
      if (code === "FORBIDDEN" || code === "UNAUTHORIZED") { setDenied(true); setCreditNotes(null); setCanCreate(false) }
      else setLoadError(failure)
    }
  }, [invoice.id])

  // Switching organization keeps the panel mounted, so start over with nothing allowed.
  useQueryRefresh(["creditNotes"], () => { void load() })

  useEffect(() => {
    setCanCreate(false)
    setCreditNotes(null)
    setDenied(false)
    if (organizationId === undefined) return
    void load()
    return () => { latestLoad.current++ }
  }, [load, organizationId])

  useEffect(() => onRequestDone(done => { if (done.kind === "creditNote" && done.invoiceId === invoice.id) void load() }), [invoice.id, load])

  if (denied) return null
  if (!creditNotes) return loadError ? <QueryError error={loadError} retry={load} /> : <QuerySkeleton />

  const creditedCents = creditNotes.filter(note => note.status === "issued").reduce((sum, creditNote) => sum + Math.round(creditNote.total * 100), 0)
  const credited = creditedCents / 100
  const fullyCredited = creditedCents >= Math.round(invoice.total * 100) && invoice.total > 0
  // Only offer credit notes to people the server lets issue them (not accountants).
  const canCredit = canCreate && invoice.status !== "draft" && !fullyCredited
  const money = (value: number) => formatCurrency(value, invoice.currency, locale)

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle>{t("creditNotes.panel.title")}</CardTitle>
          <CardDescription>
            {!canCreate
              ? t("creditNotes.panel.readOnly")
              : invoice.status === "draft"
                ? t("creditNotes.panel.draftHint")
                : fullyCredited
                  ? t("creditNotes.panel.fullyCredited")
                  : t("creditNotes.panel.description")}
          </CardDescription>
        </div>
        {canCredit && (
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            <FileMinus className="size-4" />
            {t("creditNotes.action.create")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        {loadError ? <QueryError error={loadError} retry={load} /> : null}
        {creditNotes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("creditNotes.panel.empty")}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {t("creditNotes.panel.credited", { credited: money(credited), total: money(invoice.total) })}
            </p>
            <CreditNotesTable creditNotes={creditNotes} showInvoice={false} />
          </>
        )}
      </CardContent>

      {canCredit && (
        <CreateCreditNoteDialog
          invoiceId={invoice.id}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onIssued={async (created) => {
            await Promise.all([load(), onChanged()])
            void navigate({ to: "/credit-notes/$creditNoteId", params: { creditNoteId: created.id } })
          }}
        />
      )}
    </Card>
  )
}
