import { useNavigate } from "@tanstack/react-router"
import { formatCurrency, formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table"
import type { CreditNoteListItem } from "./types"

/** Credit notes as rows linking to their detail page. */
export function CreditNotesTable({
  creditNotes,
  showInvoice = true,
}: {
  creditNotes: CreditNoteListItem[]
  /** Hide the invoice and customer columns when listing one invoice's credit notes. */
  showInvoice?: boolean
}) {
  const { t, locale } = useI18n()
  const navigate = useNavigate()

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("creditNotes.table.number")}</TableHead>
            {showInvoice && <TableHead>{t("creditNotes.table.invoice")}</TableHead>}
            {showInvoice && <TableHead>{t("creditNotes.table.customer")}</TableHead>}
            <TableHead>{t("creditNotes.table.date")}</TableHead>
            {!showInvoice && <TableHead>{t("creditNotes.table.reason")}</TableHead>}
            <TableHead className="text-right">{t("creditNotes.table.total")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {creditNotes.map((creditNote) => (
            <TableRow
              key={creditNote.id}
              className="cursor-pointer"
              onClick={() =>
                navigate({
                  to: "/credit-notes/$creditNoteId",
                  params: { creditNoteId: creditNote.id },
                })
              }
            >
              <TableCell className="font-medium">{creditNote.number}</TableCell>
              {showInvoice && <TableCell>{creditNote.invoice.number}</TableCell>}
              {showInvoice && <TableCell>{creditNote.contact.name}</TableCell>}
              <TableCell>
                {formatDate(creditNote.issueDate, locale, undefined, { month: "short" })}
              </TableCell>
              {!showInvoice && (
                <TableCell className="max-w-[240px] truncate text-muted-foreground">
                  {creditNote.reason}
                </TableCell>
              )}
              <TableCell className="text-right">
                -{formatCurrency(creditNote.total, creditNote.currency, locale)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
