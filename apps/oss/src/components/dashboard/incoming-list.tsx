import { Link } from "@tanstack/react-router"
import { ArrowRight } from "lucide-react"

import { formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { useRequestPreview } from "../command-bar/request-preview"
import { cn } from "../../lib/utils"
import { Amount } from "../kvit/amount"
import { CustomerMark } from "../kvit/customer-mark"
import { listRowLinkClass } from "../kvit/list"
import { Panel } from "../kvit/panel"
import { DocLink } from "./doc-link"
import { tCount, type Translate } from "./i18n"
import { ReminderFailureNote, RemindAction } from "./remind-action"
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

/**
 * Invoices that are due soon or already late, earliest first, each with what is still owed on a
 * single rule, or a second one drawn as far as it has been paid or credited. The reminder action shows on hover and
 * focus where there is a pointer, and always on touch, like the row actions of the lists. An
 * invoice that is already in the attention list gets its reminder there, not twice.
 */
export function IncomingList({
  items,
  today,
  inAttention,
  reminders,
  onRemind,
  newInvoiceId,
}: {
  items: IncomingItem[]
  today: string
  /** Invoices the attention list already shows, with their reminder: never offered or reported twice. */
  inAttention: ReadonlySet<string>
  reminders: Record<string, ReminderState>
  onRemind: (invoiceId: string) => void
  /** A row that has just arrived grows in and carries a highlight that fades out. */
  newInvoiceId?: string
}) {
  const { t, locale } = useI18n()
  // While a card on the page is looked at, the list shows what it would do: the invoice it would
  // add, the invoices it would settle or remind.
  const preview = useRequestPreview()
  const marked = preview && preview.kind !== "invoice" ? new Set(preview.invoiceIds) : null
  const ghost = preview?.kind === "invoice" ? (
    <li key="ghost" className="incoming-ghost border-hairline relative border-t first:border-t-0">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-3">
        <CustomerMark name={preview.customer} className="mt-0.5" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{preview.customer}</p>
          <p className="text-brand-text text-xs">{t("dashboard.incoming.ghost", { date: formatDate(preview.dueDate, locale) })}</p>
        </div>
        <Amount value={preview.amount.toFixed(2)} currency={preview.currency} locale={locale} size="sm" className="-mt-0.5" />
      </div>
    </li>
  ) : null

  return (
    <Panel
      label={t("dashboard.incoming.title")}
      data-slot="dashboard-incoming"
      action={
        <Link
          to="/invoices"
          className="text-brand-text hover:text-foreground inline-flex items-center gap-1 text-xs font-semibold transition-colors"
        >
          {t("dashboard.incoming.all")}
          <ArrowRight aria-hidden="true" className="size-3" />
        </Link>
      }
    >
      {items.length === 0 && !ghost ? (
        <p className="text-muted-foreground px-4 pt-1 pb-5 text-sm">{t("dashboard.incoming.empty")}</p>
      ) : (
        <ul>
          {ghost}
          {items.map((item) => {
            const due = dueLabel(item, today)
            const late = due.kind === "overdue"
            const covered = inAttention.has(item.documentId)
            const offerReminder = item.canRemind && !covered
            const reminderState = covered ? undefined : reminders[item.documentId]
            // A refusal that the reload has since made final (canRemind is now false) is told, not
            // offered again: a retry would send a reminder the server no longer allows.
            const finalRefusal = reminderState?.status === "error" && !item.canRemind
            return (
              <li
                key={item.documentId}
                data-preview={marked?.has(item.documentId) ? preview!.kind : undefined}
                className={cn("group/row border-hairline hover:bg-foreground/[0.035] has-[a:focus-visible]:bg-foreground/[0.035] relative border-t transition-colors duration-(--duration-fade) first:border-t-0", item.documentId === newInvoiceId && "incoming-new")}
              >
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-3">
                  <CustomerMark name={item.customerName} className="mt-0.5" />
                  <div className="min-w-0">
                    <DocLink
                      kind="invoice"
                      id={item.documentId}
                      aria-label={
                        item.number
                          ? t("dashboard.incoming.rowLink", { number: item.number, customer: item.customerName })
                          : t("dashboard.incoming.rowLinkDraft", { customer: item.customerName })
                      }
                      className={cn(listRowLinkClass, "block truncate text-sm font-semibold")}
                    >
                      {item.customerName}
                    </DocLink>
                    <div className="relative">
                      <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                        {item.number ? <span className="font-mono tracking-[0.01em]">{item.number}</span> : null}
                        {marked?.has(item.documentId)
                          ? <span className={cn("font-medium", preview!.kind === "paid" ? "text-tone-success" : "text-brand-text")}>{t(preview!.kind === "paid" ? "dashboard.incoming.paying" : "dashboard.incoming.reminding")}</span>
                          : <span className={cn(late && "text-tone-warning font-medium")}>{dueText(due, t)}</span>}
                      </p>
                      {offerReminder || reminderState ? (
                        <div
                          className={cn(
                            "relative z-10 mt-1",
                            // With a pointer the action takes the place of the number and due date while
                            // the row is hovered or focused, so no row is taller for an action it hides.
                            // Without one (touch) it sits under them. Once it has something to say, it stays.
                            !reminderState &&
                              "[@media(hover:hover)]:absolute [@media(hover:hover)]:inset-0 [@media(hover:hover)]:mt-0 [@media(hover:hover)]:flex [@media(hover:hover)]:items-center [@media(hover:hover)]:bg-[color-mix(in_srgb,var(--panel),var(--foreground)_3.5%)] [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/row:opacity-100 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:group-focus-within/row:pointer-events-auto [@media(hover:hover)]:group-hover/row:pointer-events-auto transition-opacity duration-(--duration-fade)"
                          )}
                        >
                          {finalRefusal ? (
                            <ReminderFailureNote failure={reminderState.failure} />
                          ) : (
                            <RemindAction
                              state={reminderState}
                              onRemind={() => onRemind(item.documentId)}
                              size="xs"
                              variant="link"
                            />
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
    </Panel>
  )
}
