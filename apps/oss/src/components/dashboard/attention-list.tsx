import { Clock, FilePenLine, Hourglass, MailQuestion, MailWarning, type LucideIcon } from "lucide-react"

import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { Amount } from "../kvit/amount"
import { listRowLinkClass } from "../kvit/list"
import { Panel } from "../kvit/panel"
import { Button } from "../ui/button"
import { DocLink } from "./doc-link"
import { formatShortDate } from "./format-relative"
import { tCount, type Translate } from "./i18n"
import { ReminderFailureNote, RemindAction } from "./remind-action"
import { attentionAction, type AttentionItem } from "./summary-model"
import type { ReminderState } from "./use-reminders"

const reasonStyle: Record<AttentionItem["reason"], { icon: LucideIcon; tone: string }> = {
  invoice_overdue: { icon: Clock, tone: "bg-tone-danger/14 text-tone-danger" },
  draft_older_than_7_days: { icon: FilePenLine, tone: "bg-tone-muted/14 text-tone-muted" },
  quote_expiring: { icon: Hourglass, tone: "bg-tone-warning/14 text-tone-warning" },
  email_failed: { icon: MailWarning, tone: "bg-tone-danger/14 text-tone-danger" },
  email_unconfirmed: { icon: MailQuestion, tone: "bg-tone-warning/14 text-tone-warning" },
}

/**
 * Only invoices carry rules, as in the lists: money asked for gets a single one. A draft or a quote
 * has not asked for anything yet.
 */
export function attentionRule(item: AttentionItem): "none" | "single" {
  return item.kind === "invoice" && item.reason !== "draft_older_than_7_days" ? "single" : "none"
}

/**
 * The sentence under the customer: why this row is here. The days and the expiry date are the
 * server's (`daysOverdue`, `expiresOn`), not worked out here.
 */
export function attentionReason(item: AttentionItem, locale: string, t: Translate): string {
  const number = item.number ?? ""
  switch (item.reason) {
    case "invoice_overdue":
      return item.daysOverdue !== null && item.daysOverdue > 0
        ? tCount(t, "dashboard.attention.overdue.days", item.daysOverdue, { number, days: item.daysOverdue })
        : t("dashboard.attention.overdue.today", { number })
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
 * may not have arrived. Each row says why in one sentence and offers one action: the reminder
 * where the server says one can be sent, otherwise opening the document.
 */
export function AttentionList({
  items,
  reminders,
  onRemind,
}: {
  items: AttentionItem[]
  reminders: Record<string, ReminderState>
  onRemind: (invoiceId: string) => void
}) {
  const { t, locale } = useI18n()

  return (
    <Panel label={t("dashboard.attention.title")} data-slot="dashboard-attention">
      {items.length === 0 ? (
        <p className="text-muted-foreground px-4 pt-1 pb-5 text-sm">{t("dashboard.attention.empty")}</p>
      ) : (
        <ul>
          {items.map((item) => {
            // Red is the server's `isOverdue`, whatever the reason that put the row here.
            const style = item.isOverdue ? reasonStyle.invoice_overdue : reasonStyle[item.reason]
            const Icon = style.icon
            const action = attentionAction(item)
            const refusal = reminders[item.documentId]
            return (
              <li
                key={`${item.kind}-${item.documentId}-${item.reason}`}
                className="group/row border-hairline hover:bg-foreground/[0.035] has-[a:focus-visible]:bg-foreground/[0.035] relative flex gap-3 border-t px-4 py-3 transition-colors duration-150 first:border-t-0"
              >
                <span
                  aria-hidden="true"
                  className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg", style.tone)}
                >
                  <Icon className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <DocLink
                      kind={item.kind}
                      id={item.documentId}
                      className={cn(listRowLinkClass, "block min-w-0 truncate text-sm font-semibold")}
                    >
                      {item.customerName}
                    </DocLink>
                    <Amount
                      value={item.amount.amount}
                      currency={item.amount.currency}
                      locale={locale}
                      size="sm"
                      rule={attentionRule(item)}
                      className="-mt-0.5 -mb-1.5"
                    />
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {attentionReason(item, locale, t)}
                  </p>
                  <div className="relative z-10 mt-2">
                    {action === "remind" || reminders[item.documentId]?.status === "sent" ? (
                      <RemindAction
                        state={reminders[item.documentId]}
                        onRemind={() => onRemind(item.documentId)}
                      />
                    ) : (
                      <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                        <Button asChild variant="outline" size="sm">
                          <DocLink kind={item.kind} id={item.documentId}>
                            {attentionOpenLabel(item, t)}
                          </DocLink>
                        </Button>
                        {/* The refusal stays after the reload took the reminder away (it was already sent today). */}
                        {refusal?.status === "error" ? <ReminderFailureNote failure={refusal.failure} /> : null}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
