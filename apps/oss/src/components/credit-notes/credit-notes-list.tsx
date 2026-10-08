import { Link } from "@tanstack/react-router"

import { formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { Amount } from "../kvit/amount"
import { decimalFromNumber } from "../kvit/amount-format"
import { CustomerMark } from "../kvit/customer-mark"
import {
  ListBody,
  ListCell,
  ListHead,
  ListHeadCell,
  ListRow,
  ListTable,
  listRowLinkClass,
} from "../kvit/list"
import { StatusBadge } from "../status-badge"
import type { CreditNoteListItem } from "./types"

/**
 * The credit notes page: one row per credit note, with the customer, the invoice it credits and
 * the amount taken off. The invoice page lists its own credit notes in `CreditNotesTable`.
 */
export function CreditNotesList({ creditNotes }: { creditNotes: CreditNoteListItem[] }) {
  const { t, locale } = useI18n()

  return (
    <ListTable
      label={t("creditNotes.title")}
      columns="minmax(0,2.2fr) 7.5rem 7.5rem 7.5rem minmax(8.5rem,1fr) 8.5rem"
    >
      <ListHead>
        <ListHeadCell>{t("creditNotes.table.customer")}</ListHeadCell>
        <ListHeadCell>{t("creditNotes.table.number")}</ListHeadCell>
        <ListHeadCell>{t("creditNotes.table.invoice")}</ListHeadCell>
        <ListHeadCell>{t("creditNotes.table.date")}</ListHeadCell>
        <ListHeadCell align="end">{t("creditNotes.table.total")}</ListHeadCell>
        <ListHeadCell>{t("creditNotes.table.status")}</ListHeadCell>
      </ListHead>
      <ListBody>
        {creditNotes.map((creditNote) => {
          const date = formatDate(creditNote.issueDate, locale, undefined, { month: "short" })
          return (
            <ListRow key={creditNote.id}>
              <ListCell className="max-md:col-start-1 max-md:row-start-1">
                <div className="flex min-w-0 items-center gap-2.5">
                  <CustomerMark name={creditNote.contact.name} />
                  <div className="min-w-0">
                    <Link
                      to="/credit-notes/$creditNoteId"
                      params={{ creditNoteId: creditNote.id }}
                      className={cn(listRowLinkClass, "block truncate font-semibold")}
                    >
                      {creditNote.contact.name}
                    </Link>
                    <span className="text-muted-foreground block truncate text-xs md:hidden">
                      {date}
                    </span>
                  </div>
                </div>
              </ListCell>
              <ListCell className="font-mono text-[12.5px] tracking-[0.01em] max-md:col-start-1 max-md:row-start-2">
                {creditNote.number}
              </ListCell>
              <ListCell className="text-muted-foreground font-mono text-[12.5px] tracking-[0.01em] max-md:hidden">
                {creditNote.invoice.number}
              </ListCell>
              <ListCell className="text-muted-foreground max-md:hidden">{date}</ListCell>
              <ListCell align="end" className="max-md:col-start-2 max-md:row-start-1">
                {/* Money taken off, so no rule: the double rule says money has arrived. */}
                <Amount
                  value={`-${decimalFromNumber(creditNote.total, creditNote.currency)}`}
                  currency={creditNote.currency}
                  locale={locale}
                />
              </ListCell>
              <ListCell className="max-md:col-start-2 max-md:row-start-2 max-md:justify-self-end">
                <StatusBadge domain="creditNote" status={creditNote.status} />
              </ListCell>
            </ListRow>
          )
        })}
      </ListBody>
    </ListTable>
  )
}
