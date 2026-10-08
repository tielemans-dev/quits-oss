import type { TranslationKey } from "../../lib/i18n/messages"
import type { ActivityEvent } from "./summary-model"

/**
 * The dashboard's activity feed shows what happened to documents, in a few words. Event types
 * come from the domain event log (see `src/domain`); the log holds many more than a person wants
 * to read, so only the types below are shown and the rest are left out on purpose: edits of a
 * draft, deleted drafts, voided numbers, valuations, stored artifacts, paused reminders and
 * settings. Unknown types are left out too, so a new event never shows up as raw text.
 *
 * Each kind has a singular and a plural label (`dashboard.activity.<kind>.one|other`).
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

const KIND_BY_TYPE: Record<string, ActivityKind> = {
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
  "invoice.email_unconfirmed": "deliveryUnconfirmed",
  "invoice.reminder_unconfirmed": "deliveryUnconfirmed",
  "quote.email_unconfirmed": "deliveryUnconfirmed",
  "credit_note.email_unconfirmed": "deliveryUnconfirmed",
  "invoice.became_overdue": "invoiceOverdue",
  "credit_note.issued": "creditNoteIssued",
  "quote.draft_created": "quoteDraft",
  "quote.sent": "quoteSent",
  "quote.email_resent": "quoteSent",
  "quote.accepted": "quoteAccepted",
  "quote.rejected": "quoteRejected",
  "quote.converted": "quoteConverted",
  "agreement.sent": "agreementSent",
  "agreement.offer_issued": "agreementSent",
  "agreement.accepted": "agreementAccepted",
}

export function activityKind(type: string): ActivityKind | null {
  return KIND_BY_TYPE[type] ?? null
}

export type ActivityTarget =
  | { to: "invoice"; id: string }
  | { to: "quote"; id: string }
  | { to: "creditNote"; id: string }
  | { to: "agreement"; id: string }
  | { to: "none" }

/** The document an event is about. A payment event has no page of its own. */
export function activityTarget(event: Pick<ActivityEvent, "aggregateType" | "aggregateId">): ActivityTarget {
  switch (event.aggregateType) {
    case "invoice":
      return { to: "invoice", id: event.aggregateId }
    case "quote":
      return { to: "quote", id: event.aggregateId }
    case "credit_note":
    case "creditNote":
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
  /** How many documents the line stands for: neighbours of the same kind are merged. */
  count: number
  occurredAt: string
  /** The document, when the line is about exactly one. */
  target: ActivityTarget
}

/**
 * Turns the newest-first event list into the lines of the feed:
 * - types without a label are dropped;
 * - a payment that settled an invoice is dropped when that invoice also says it is paid, since
 *   one fact should not be told twice;
 * - neighbours of the same kind merge ("3 fakturaer sendt"), counting each document once.
 */
export function describeActivity(events: ActivityEvent[]): ActivityLine[] {
  const paidInvoices = new Set(
    events.filter((event) => event.type === "invoice.paid").map((event) => event.aggregateId)
  )
  const lines: Array<ActivityLine & { documents: Set<string> }> = []
  for (const event of events) {
    const kind = activityKind(event.type)
    if (!kind) continue
    if (event.type === "payment.recorded" && paidInvoices.has(event.aggregateId)) continue
    const previous = lines[lines.length - 1]
    if (previous && previous.kind === kind) {
      previous.documents.add(event.aggregateId)
      previous.count = previous.documents.size
      if (previous.count > 1) previous.target = { to: "none" }
      continue
    }
    lines.push({
      id: event.id,
      kind,
      count: 1,
      occurredAt: event.occurredAt,
      target: activityTarget(event),
      documents: new Set([event.aggregateId]),
    })
  }
  return lines.map(({ documents: _documents, ...line }) => line)
}

export function activityLabelKey(kind: ActivityKind, count: number): TranslationKey {
  return `dashboard.activity.${kind}.${count === 1 ? "one" : "other"}` as TranslationKey
}

/** The list a merged line leads to, since it stands for more than one document. */
export function activityListFor(kind: ActivityKind): "invoices" | "quotes" | "credit-notes" | "agreements" | null {
  if (kind.startsWith("invoice") || kind === "paymentRecorded" || kind === "paymentVoided" || kind === "reminderSent") {
    return "invoices"
  }
  if (kind.startsWith("quote")) return "quotes"
  if (kind === "creditNoteIssued") return "credit-notes"
  if (kind.startsWith("agreement")) return "agreements"
  return null
}
