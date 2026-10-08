import type { TranslationKey } from "./i18n/messages"

/**
 * One status system. Every status a Quits screen shows maps to a tone (how it reads at a glance)
 * and an i18n label key. The tone colours are defined in styles.css and drawn as soft pills (a 14%
 * tint with the label at full strength) by StatusBadge. Kvit-blå, the brand colour, is the "info" tone.
 *
 * - neutral: not started or not yet decided (draft, planned)
 * - info: out with the customer, waiting on them (sent, open)
 * - progress: the customer has engaged (viewed, in progress)
 * - success: settled or running as intended (paid, accepted, active)
 * - warning: needs attention but is not broken (partially paid, paused, delivery unconfirmed)
 * - danger: failed, or past due (overdue, failed, rejected)
 * - muted: finished and no longer actionable (credited, cancelled, expired, ended)
 */
export type StatusTone =
  | "neutral"
  | "info"
  | "progress"
  | "success"
  | "warning"
  | "danger"
  | "muted"

export type StatusEntry = { tone: StatusTone; labelKey: TranslationKey }

/**
 * The statuses of each domain, from the schemas in `@quits/contracts` (see the status-tones tests,
 * which fail when a contract gains a status that is missing here).
 */
export const statusTones = {
  /**
   * `partially_paid` is not a lifecycle status: it is derived from `paymentStatus` by
   * `invoiceDisplayStatus`, so a sent invoice with some money received reads as partially paid.
   */
  invoice: {
    draft: { tone: "neutral", labelKey: "status.draft" },
    sent: { tone: "info", labelKey: "status.sent" },
    viewed: { tone: "progress", labelKey: "status.viewed" },
    partially_paid: { tone: "warning", labelKey: "status.partially_paid" },
    paid: { tone: "success", labelKey: "status.paid" },
    overdue: { tone: "danger", labelKey: "status.overdue" },
    credited: { tone: "muted", labelKey: "status.credited" },
  },
  /** `expired` shows only when the server returns it; nothing here derives it from the expiry date. */
  quote: {
    draft: { tone: "neutral", labelKey: "quotes.status.draft" },
    sent: { tone: "info", labelKey: "quotes.status.sent" },
    accepted: { tone: "success", labelKey: "quotes.status.accepted" },
    rejected: { tone: "danger", labelKey: "quotes.status.rejected" },
    expired: { tone: "muted", labelKey: "quotes.status.expired" },
  },
  creditNote: {
    issued: { tone: "info", labelKey: "status.issued" },
  },
  recurring: {
    active: { tone: "success", labelKey: "recurring.status.active" },
    paused: { tone: "warning", labelKey: "recurring.status.paused" },
    ended: { tone: "muted", labelKey: "recurring.status.ended" },
  },
  agreement: {
    draft: { tone: "neutral", labelKey: "status.draft" },
    sent: { tone: "info", labelKey: "status.sent" },
    accepted: { tone: "success", labelKey: "status.accepted" },
    declined: { tone: "danger", labelKey: "status.declined" },
    expired: { tone: "muted", labelKey: "status.expired" },
    completed: { tone: "success", labelKey: "status.completed" },
    cancelled: { tone: "muted", labelKey: "status.cancelled" },
  },
  deliverable: {
    planned: { tone: "neutral", labelKey: "agreements.fulfillment.planned" },
    in_progress: { tone: "progress", labelKey: "agreements.fulfillment.in_progress" },
    delivered: { tone: "info", labelKey: "agreements.fulfillment.delivered" },
    accepted: { tone: "success", labelKey: "agreements.fulfillment.accepted" },
    changes_requested: { tone: "warning", labelKey: "agreements.fulfillment.changes_requested" },
    cancelled: { tone: "muted", labelKey: "agreements.fulfillment.cancelled" },
  },
  deliverableBilling: {
    unbilled: { tone: "neutral", labelKey: "agreements.billing.unbilled" },
    reserved: { tone: "progress", labelKey: "agreements.billing.reserved" },
    invoiced: { tone: "success", labelKey: "agreements.billing.invoiced" },
  },
  /** Where a piece of billable work stands, derived from its allocation and issued credits. Nothing here is "scheduled": no scheduler bills work. */
  billableAllocation: {
    unbilled: { tone: "neutral", labelKey: "agreements.billing.unbilled" },
    reserved: { tone: "progress", labelKey: "agreements.billing.reserved" },
    invoiced: { tone: "success", labelKey: "agreements.billing.invoiced" },
    partially_credited: { tone: "warning", labelKey: "agreements.billing.partially_credited" },
    credited: { tone: "info", labelKey: "agreements.billing.credited" },
  },
  /**
   * The outcome of the last attempt to email a document. `skipped` means the document was issued
   * without an email, so the customer has not been told.
   */
  emailDelivery: {
    sent: { tone: "success", labelKey: "invoices.detail.email.status.sent" },
    skipped: { tone: "warning", labelKey: "invoices.detail.email.status.skipped" },
    failed: { tone: "danger", labelKey: "invoices.detail.email.status.failed" },
    sending: { tone: "info", labelKey: "invoices.detail.email.status.sending" },
    unconfirmed: { tone: "warning", labelKey: "invoices.detail.email.status.unconfirmed" },
  },
  reminder: {
    upcoming: { tone: "neutral", labelKey: "reminders.status.upcoming" },
    scheduled: { tone: "info", labelKey: "reminders.status.scheduled" },
    sent: { tone: "success", labelKey: "reminders.status.sent" },
    unconfirmed: { tone: "warning", labelKey: "reminders.status.unconfirmed" },
    failed: { tone: "danger", labelKey: "reminders.status.failed" },
    skipped: { tone: "muted", labelKey: "reminders.status.skipped" },
  },
  /** Whether this installation can send email at all (Settings). */
  emailSetup: {
    configured: { tone: "success", labelKey: "settings.emailDelivery.status.configured" },
    missing_configuration: {
      tone: "warning",
      labelKey: "settings.emailDelivery.status.missing_configuration",
    },
    managed: { tone: "info", labelKey: "settings.emailDelivery.status.managed" },
    managed_unavailable: {
      tone: "warning",
      labelKey: "settings.emailDelivery.status.managed_unavailable",
    },
  },
  /** Setup of the organization's own sending domain (Settings). */
  documentSending: {
    not_configured: { tone: "neutral", labelKey: "settings.documentSending.status.not_configured" },
    pending_dns: { tone: "warning", labelKey: "settings.documentSending.status.pending_dns" },
    verifying: { tone: "info", labelKey: "settings.documentSending.status.verifying" },
    verified: { tone: "success", labelKey: "settings.documentSending.status.verified" },
    failed: { tone: "danger", labelKey: "settings.documentSending.status.failed" },
  },
} as const satisfies Record<string, Record<string, StatusEntry>>

export type StatusDomain = keyof typeof statusTones
export type StatusOf<Domain extends StatusDomain> = keyof (typeof statusTones)[Domain] & string

/** The tone and label key of a status, or undefined for one this client does not know. */
export function getStatusEntry(domain: StatusDomain, status: string): StatusEntry | undefined {
  const entries: Record<string, StatusEntry> = statusTones[domain]
  return Object.hasOwn(entries, status) ? entries[status] : undefined
}

/** The tone of a status; unknown statuses read as neutral rather than guessing a meaning. */
export function getStatusTone(domain: StatusDomain, status: string): StatusTone {
  return getStatusEntry(domain, status)?.tone ?? "neutral"
}

/** The translated label of a status; an unknown status shows as it is rather than as another one. */
export function getStatusLabel(
  t: (key: TranslationKey) => string,
  domain: StatusDomain,
  status: string
): string {
  const entry = getStatusEntry(domain, status)
  return entry ? t(entry.labelKey) : status
}
