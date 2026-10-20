import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { Amount } from "../kvit/amount"
import { listRowLinkClass } from "../kvit/list"
import { Button } from "../ui/button"
import { DocLink } from "./doc-link"
import { formatShortDate } from "./format-relative"
import { tCount, type Translate } from "./i18n"
import { ReminderFailureNote, RemindAction } from "./remind-action"
import { DashboardSection, SectionEmpty, sectionRowClass } from "./section"
import { attentionAction, isLate, precisionOf, type AttentionItem } from "./summary-model"
import type { ReminderState } from "./use-reminders"

/**
 * The tone of a row's reason: amber for a real arrear (`isOverdue` with days, whatever reason put
 * the row here) and a quote about to lapse, red for an email that failed, quiet for the rest. Due
 * today is not late yet, so it is quiet.
 */
export function attentionTone(item: AttentionItem): "warning" | "danger" | "muted" {
  if (isLate(item) || item.reason === "quote_expiring") return "warning"
  return item.reason === "email_failed" ? "danger" : "muted"
}

/**
 * The sentence under the customer: why this row is here. The days and the expiry date are the
 * server's (`daysOverdue`, `expiresOn`), not worked out here.
 */
export function attentionReason(item: AttentionItem, locale: string, t: Translate): string {
  const number = item.number ?? ""
  switch (item.reason) {
    case "invoice_overdue":
      return isLate(item)
        ? tCount(t, "dashboard.attention.overdue.days", item.daysOverdue!, { number, days: item.daysOverdue! })
        : t("dashboard.attention.dueToday", { number })
    case "draft_older_than_7_days":
      return item.kind === "quote" ? t("dashboard.attention.draftQuote") : t("dashboard.attention.draftInvoice")
    case "quote_expiring":
      return item.expiresOn
        ? t("dashboard.attention.quoteExpiresOn", { number, date: formatShortDate(item.expiresOn, locale) })
        : t("dashboard.attention.quoteExpiring", { number })
    case "email_failed":
      return t("dashboard.attention.emailFailed", { number })
    case "email_unconfirmed":
      return t("dashboard.attention.emailUnconfirmed", { number })
  }
}

/** The label of the one action that opens the document. */
export function attentionOpenLabel(item: AttentionItem, t: Translate): string {
  switch (item.reason) {
    case "draft_older_than_7_days":
      return t("dashboard.attention.action.openDraft")
    case "quote_expiring":
      return t("dashboard.attention.action.followUp")
    case "email_failed":
    case "email_unconfirmed":
      return t("dashboard.attention.action.checkDelivery")
    case "invoice_overdue":
      return t("dashboard.attention.action.openInvoice")
  }
}

/**
 * What needs the person today: overdue invoices, old drafts, quotes about to lapse and emails that
 * may not have arrived. Each row is one line: who, why in a muted sentence, the amount, and one
 * quiet action on the right: the reminder where the server says one can be sent, otherwise
 * opening the document. The whole row opens the document.
 */
export function AttentionList({
  items,
  reminders,
  onRemind,
  onRemindAll,
  className,
}: {
  items: AttentionItem[]
  reminders: Record<string, ReminderState>
  onRemind: (invoiceId: string) => void
  /** Queues one reminder job for these invoices; the corner tracker shows it. */
  onRemindAll?: (invoiceIds: string[]) => void
  className?: string
}) {
  const { t, locale } = useI18n()
  const remindable = items.filter((item) => attentionAction(item) === "remind").map((item) => item.documentId)

  return (
    <DashboardSection
      title={t("dashboard.attention.title")}
      data-slot="dashboard-attention"
      className={className}
      action={
        onRemindAll && remindable.length > 1 ? (
          <Button type="button" variant="ghost" size="xs" className="text-brand-text -mr-2" onClick={() => onRemindAll(remindable)}>
            {t("dashboard.attention.remindAll", { count: remindable.length })}
          </Button>
        ) : null
      }
    >
      {items.length === 0 ? (
        <SectionEmpty>{t("dashboard.attention.empty")}</SectionEmpty>
      ) : (
        <ul>
          {items.map((item) => {
            const action = attentionAction(item)
            const refusal = reminders[item.documentId]
            const tone = attentionTone(item)
            return (
              <li
                key={`${item.kind}-${item.documentId}-${item.reason}`}
                className={cn(sectionRowClass, "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 @md:grid-cols-[minmax(0,1fr)_auto_minmax(9rem,auto)]")}
              >
                <div className="min-w-0">
                  <DocLink
                    kind={item.kind}
                    id={item.documentId}
                    className={cn(listRowLinkClass, "block truncate text-sm font-medium")}
                  >
                    {item.customerName}
                  </DocLink>
                  <p
                    data-tone={tone}
                    className={cn(
                      "truncate text-xs",
                      tone === "warning" ? "text-tone-warning" : tone === "danger" ? "text-tone-danger" : "text-muted-foreground"
                    )}
                  >
                    {attentionReason(item, locale, t)}
                  </p>
                </div>
                <Amount
                  value={item.amount.amount}
                  currency={item.amount.currency}
                  locale={locale}
                  size="sm"
                  precision={precisionOf(item.amount)}
                />
                <div className="relative z-10 col-span-2 flex @md:col-span-1 @md:justify-end">
                  {action === "remind" || refusal?.status === "sent" ? (
                    <RemindAction state={refusal} onRemind={() => onRemind(item.documentId)} size="xs" />
                  ) : (
                    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 @md:justify-end">
                      {/* The refusal stays after the reload took the reminder away (it was already sent today). */}
                      {refusal?.status === "error" ? <ReminderFailureNote failure={refusal.failure} /> : null}
                      <Button asChild variant="outline" size="xs">
                        <DocLink kind={item.kind} id={item.documentId}>
                          {attentionOpenLabel(item, t)}
                        </DocLink>
                      </Button>
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </DashboardSection>
  )
}
