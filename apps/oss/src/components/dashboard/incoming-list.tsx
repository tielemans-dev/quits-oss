import { Link } from "@tanstack/react-router"

import { formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { useRequestPreview } from "../command-bar/request-preview"
import { cn } from "../../lib/utils"
import { Amount } from "../kvit/amount"
import { listRowLinkClass } from "../kvit/list"
import { Button } from "../ui/button"
import { DocLink } from "./doc-link"
import { tCount, type Translate } from "./i18n"
import { ReminderFailureNote, RemindAction } from "./remind-action"
import { DashboardSection, SectionEmpty, sectionRowFrame } from "./section"
import { dueLabel, precisionOf, type DueLabel, type IncomingItem } from "./summary-model"
import type { ReminderState } from "./use-reminders"

export function dueText(due: DueLabel, t: Translate): string {
  switch (due.kind) {
    case "overdue":
      return tCount(t, "dashboard.incoming.overdue", due.days, { days: due.days })
    case "today":
      return t("dashboard.incoming.today")
    case "tomorrow":
      return t("dashboard.incoming.tomorrow")
    case "later":
      return t("dashboard.incoming.later", { days: due.days })
  }
}

// With a pointer the reminder takes the place of the number and due date while the row is hovered
// or focused, so no row is taller for an action it hides. Without one (touch) it sits under them.
const actionInPlace =
  "mt-1 [grid-area:2/1] [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:mt-0 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:[grid-area:1/1] [@media(hover:hover)]:group-focus-within/row:pointer-events-auto [@media(hover:hover)]:group-focus-within/row:opacity-100 [@media(hover:hover)]:group-hover/row:pointer-events-auto [@media(hover:hover)]:group-hover/row:opacity-100"
const metaGivesWay = "[@media(hover:hover)]:group-focus-within/row:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-0"

/**
 * Open invoices on their way in, earliest first: who, the number and when it is due, and what is
 * still owed. An invoice the attention list already shows is not repeated here, unless a card on
 * the page is about to settle or remind it.
 */
export function IncomingList({
  items,
  today,
  inAttention,
  reminders,
  onRemind,
  newInvoiceId,
  className,
}: {
  items: IncomingItem[]
  today: string
  /** Invoices the attention list already shows, with their reminder: never listed, offered or reported twice. */
  inAttention: ReadonlySet<string>
  reminders: Record<string, ReminderState>
  onRemind: (invoiceId: string) => void
  /** A row that has just arrived grows in and carries a highlight that fades out. */
  newInvoiceId?: string
  className?: string
}) {
  const { t, locale } = useI18n()
  // While a card on the page is looked at, the list shows what it would do: the invoice it would
  // add, the invoices it would settle or remind.
  const preview = useRequestPreview()
  const marked = preview && preview.kind !== "invoice" ? new Set(preview.invoiceIds) : null
  const shown = items.filter((item) => !inAttention.has(item.documentId) || marked?.has(item.documentId))
  const ghost =
    preview?.kind === "invoice" ? (
      <li key="ghost" className={cn(sectionRowFrame, "incoming-ghost")}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 px-3 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{preview.customer}</p>
            <p className="text-brand-text text-xs">{t("dashboard.incoming.ghost", { date: formatDate(preview.dueDate, locale) })}</p>
          </div>
          <Amount value={preview.amount.toFixed(2)} currency={preview.currency} locale={locale} size="sm" />
        </div>
      </li>
    ) : null

  return (
    <DashboardSection
      title={t("dashboard.incoming.title")}
      data-slot="dashboard-incoming"
      className={className}
      action={
        <Button asChild variant="ghost" size="xs" className="text-brand-text -mr-2">
          <Link to="/invoices">{t("dashboard.incoming.all")}</Link>
        </Button>
      }
    >
      {shown.length === 0 && !ghost ? (
        <SectionEmpty>{t(items.length ? "dashboard.incoming.allAbove" : "dashboard.incoming.empty")}</SectionEmpty>
      ) : (
        <ul>
          {ghost}
          {shown.map((item) => {
            const due = dueLabel(item, today)
            const covered = inAttention.has(item.documentId)
            const reminderState = covered ? undefined : reminders[item.documentId]
            const offerReminder = (item.canRemind && !covered) || Boolean(reminderState)
            // A refusal that the reload has since made final (canRemind is now false) is told, not
            // offered again: a retry would send a reminder the server no longer allows.
            const finalRefusal = reminderState?.status === "error" && !item.canRemind
            const previewKind = marked?.has(item.documentId) ? preview!.kind : undefined
            return (
              <li
                key={item.documentId}
                data-preview={previewKind}
                className={cn("group/row", sectionRowFrame, item.documentId === newInvoiceId && "incoming-new")}
              >
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 px-3 py-3">
                  <div className="min-w-0">
                    <DocLink
                      kind="invoice"
                      id={item.documentId}
                      aria-label={
                        item.number
                          ? t("dashboard.incoming.rowLink", { number: item.number, customer: item.customerName })
                          : t("dashboard.incoming.rowLinkDraft", { customer: item.customerName })
                      }
                      className={cn(listRowLinkClass, "block truncate text-sm font-medium")}
                    >
                      {item.customerName}
                    </DocLink>
                    <div className="grid text-xs">
                      <p
                        className={cn(
                          "text-muted-foreground flex min-w-0 gap-x-2 transition-opacity duration-(--duration-fade) [grid-area:1/1]",
                          offerReminder && !reminderState && metaGivesWay
                        )}
                      >
                        {item.number ? <span className="tabular-nums">{item.number}</span> : null}
                        {previewKind ? (
                          <span className={cn("font-medium", previewKind === "paid" ? "text-tone-success" : "text-brand-text")}>
                            {t(previewKind === "paid" ? "dashboard.incoming.paying" : "dashboard.incoming.reminding")}
                          </span>
                        ) : (
                          <span className={cn("truncate", due.kind === "overdue" && "text-tone-warning")}>{dueText(due, t)}</span>
                        )}
                      </p>
                      {offerReminder ? (
                        <div
                          className={cn(
                            "relative z-10 flex items-center transition-opacity duration-(--duration-fade)",
                            // Once it has something to say, it stays, under the due date.
                            reminderState ? "mt-1 [grid-area:2/1]" : actionInPlace
                          )}
                        >
                          {finalRefusal ? (
                            <ReminderFailureNote failure={reminderState.failure} />
                          ) : (
                            <RemindAction state={reminderState} onRemind={() => onRemind(item.documentId)} size="xs" variant="link" />
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <Amount
                    value={item.amount.amount}
                    currency={item.amount.currency}
                    locale={locale}
                    size="sm"
                    precision={precisionOf(item.amount)}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </DashboardSection>
  )
}
