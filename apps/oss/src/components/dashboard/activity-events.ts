import { DASHBOARD_ACTIVITY_EVENT_TYPES, type DashboardActivityEventType } from "@quits/contracts/dashboard"

import type { TranslationKey } from "../../lib/i18n/messages"
import type { ActivityEvent } from "./summary-model"

/**
 * The dashboard's activity feed shows what happened to documents, in a few words. The server has
 * already left out what a person has no use for (draft edits, voided numbers, valuations, stored
 * artifacts, settings), so every event that arrives has a label. `Record<DashboardActivityEventType, ...>`
 * makes a type added to the contract's allowlist a compile error here until it is labelled.
 *
 * Each kind has two labels in the catalogue, `dashboard.activity.<kind>` and
 * `dashboard.activity.<kind>.numbered` (with `{number}`), since a draft has no number yet.
 */
export const ACTIVITY_KINDS = [
  "invoiceDraft",
  "invoiceSent",
  "invoicePaid",
  "paymentRecorded",
  "paymentVoided",
  "reminderSent",
  "deliveryFailed",
  "deliveryUnconfirmed",
  "invoiceOverdue",
  "creditNoteIssued",
  "quoteDraft",
  "quoteSent",
  "quoteAccepted",
  "quoteRejected",
  "quoteConverted",
  "agreementSent",
  "agreementAccepted",
] as const

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

const KIND_BY_TYPE: Record<DashboardActivityEventType, ActivityKind> = {
  "invoice.draft_created": "invoiceDraft",
  "invoice.issued": "invoiceSent",
  "invoice.sent": "invoiceSent",
  "invoice.email_resent": "invoiceSent",
  "invoice.paid": "invoicePaid",
  "payment.recorded": "paymentRecorded",
  "payment.voided": "paymentVoided",
  "invoice.reminder_sent": "reminderSent",
  "invoice.reminder_failed": "deliveryFailed",
  "invoice.email_failed": "deliveryFailed",
  "quote.email_failed": "deliveryFailed",
  "credit_note.email_failed": "deliveryFailed",
  "agreement.email_failed": "deliveryFailed",
  "invoice.email_unconfirmed": "deliveryUnconfirmed",
  "invoice.reminder_unconfirmed": "deliveryUnconfirmed",
  "quote.email_unconfirmed": "deliveryUnconfirmed",
  "credit_note.email_unconfirmed": "deliveryUnconfirmed",
  "agreement.email_unconfirmed": "deliveryUnconfirmed",
  "invoice.became_overdue": "invoiceOverdue",
  "credit_note.issued": "creditNoteIssued",
  "quote.draft_created": "quoteDraft",
  "quote.sent": "quoteSent",
  "quote.accepted": "quoteAccepted",
  "quote.rejected": "quoteRejected",
  "quote.converted": "quoteConverted",
  "agreement.sent": "agreementSent",
  "agreement.offer_issued": "agreementSent",
  "agreement.accepted": "agreementAccepted",
}

/** The kind of an event type, or null for one outside the allowlist (a newer server). */
export function activityKind(type: string): ActivityKind | null {
  return (DASHBOARD_ACTIVITY_EVENT_TYPES as readonly string[]).includes(type)
    ? KIND_BY_TYPE[type as DashboardActivityEventType]
    : null
}

export type ActivityTarget =
  | { to: "invoice"; id: string }
  | { to: "quote"; id: string }
  | { to: "creditNote"; id: string }
  | { to: "agreement"; id: string }
  | { to: "none" }

/** The document an event is about, by the server's `documentKind`. */
export function activityTarget(event: Pick<ActivityEvent, "documentKind" | "aggregateId">): ActivityTarget {
  switch (event.documentKind) {
    case "invoice":
      return { to: "invoice", id: event.aggregateId }
    case "quote":
      return { to: "quote", id: event.aggregateId }
    case "credit_note":
      return { to: "creditNote", id: event.aggregateId }
    case "agreement":
      return { to: "agreement", id: event.aggregateId }
    default:
      return { to: "none" }
  }
}

export type ActivityLine = {
  id: string
  kind: ActivityKind
  number: string | null
  customerName: string | null
  occurredAt: string
  target: ActivityTarget
}

/**
 * The lines of the feed, newest first. Two things are left out because they would tell one fact
 * twice, not because of what they are: a payment that settled an invoice that is also reported
 * paid, and a repeat of the same kind for the same document (an invoice both issued and sent).
 */
export function describeActivity(events: ActivityEvent[]): ActivityLine[] {
  const paidInvoices = new Set(
    events.filter((event) => event.type === "invoice.paid").map((event) => event.aggregateId)
  )
  const lines: ActivityLine[] = []
  const seen = new Set<string>()
  for (const event of events) {
    const kind = activityKind(event.type)
    if (!kind) continue
    if (event.type === "payment.recorded" && paidInvoices.has(event.aggregateId)) continue
    const once = `${kind}:${event.aggregateId}`
    if (seen.has(once)) continue
    seen.add(once)
    lines.push({
      id: event.id,
      kind,
      number: event.documentNumber,
      customerName: event.customerName,
      occurredAt: event.occurredAt,
      target: activityTarget(event),
    })
  }
  return lines
}

export function activityLabelKey(kind: ActivityKind, numbered: boolean): TranslationKey {
  return `dashboard.activity.${kind}${numbered ? ".numbered" : ""}` as TranslationKey
}
