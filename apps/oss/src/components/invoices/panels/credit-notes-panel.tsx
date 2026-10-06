import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { FileMinus } from "lucide-react"
import { trpc } from "../../../trpc/client"
import { formatCurrency } from "../../../lib/i18n/format"
import { useI18n } from "../../../lib/i18n/react"
import { Button } from "../../ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card"
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
  const [dialogOpen, setDialogOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const [list, capabilities] = await Promise.all([
        trpc.creditNotes.list.query({ invoiceId: invoice.id }),
        trpc.creditNotes.capabilities.query(),
      ])
      setCreditNotes(list)
      setCanCreate(capabilities.canCreate)
    } catch {
      // Members without credit note access simply do not see the panel.
      setCreditNotes(null)
    }
  }, [invoice.id])

  useEffect(() => {
    void load()
  }, [load])

  if (!creditNotes) return null

  const creditedCents = creditNotes.reduce((sum, creditNote) => sum + Math.round(creditNote.total * 100), 0)
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
