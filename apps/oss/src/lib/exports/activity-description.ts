import { enMessages, type TranslationKey } from "../i18n/messages"
import { PAYMENT_DETAIL_LABEL_KEYS } from "../payment-details-audit"
import { PAYMENT_DETAILS_FIELDS, type PaymentDetailsField } from "@quits/contracts/payment-details"

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string

export type DescribableEvent = {
  type: string
  aggregateType: string
  payload: Record<string, unknown>
}

function isTranslationKey(key: string): key is TranslationKey {
  return Object.prototype.hasOwnProperty.call(enMessages, key)
}

/** "payment.recorded" -> "Payment recorded" for event types without a catalog entry yet. */
export function humanizeEventType(type: string): string {
  const words = type.replace(/[._]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function payloadVars(payload: Record<string, unknown>) {
  const vars: Record<string, string> = { number: "", name: "", recipient: "", fields: "" }
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" || typeof value === "number") vars[key] = String(value)
  }
  return vars
}

const isPaymentDetailsField = (value: unknown): value is PaymentDetailsField =>
  PAYMENT_DETAILS_FIELDS.some((field) => field === value)

/** The names of what changed, for events that record `changes` (the values themselves stay in the log). */
function changedFieldNames(payload: Record<string, unknown>, t: Translate): string | null {
  if (!Array.isArray(payload.changes)) return null
  const fields = payload.changes.flatMap((change: unknown) => {
    const field = (change as { field?: unknown } | null)?.field
    return isPaymentDetailsField(field) ? [t(PAYMENT_DETAIL_LABEL_KEYS[field])] : []
  })
  return fields.length > 0 ? fields.join(", ") : null
}

/** The catalog key for an event, choosing a variant from its payload where one exists. */
export function activityMessageKey(event: DescribableEvent): TranslationKey | null {
  let key = `activity.event.${event.type}`
  if (event.type === "invoice.sent") {
    if (event.payload.emailSent === false) key = `${key}.noEmail`
    else if (typeof event.payload.recipient === "string" && event.payload.recipient) key = `${key}.recipient`
  }
  return isTranslationKey(key) ? key : null
}

/** A one-line, human-readable description of a domain event. */
export function describeActivity(event: DescribableEvent, t: Translate): string {
  const key = activityMessageKey(event)
  if (!key) return humanizeEventType(event.type)
  const vars = payloadVars(event.payload)
  const fields = changedFieldNames(event.payload, t)
  if (fields) vars.fields = fields
  return t(key, vars).replace(/\s+/g, " ").trim()
}

/** Label of an aggregate type ("credit_note" and "creditNote" both map to "Credit note"). */
export function aggregateLabel(aggregateType: string, t: Translate): string {
  const camel = aggregateType.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
  const key = `activity.aggregate.${camel}`
  return isTranslationKey(key) ? t(key) : humanizeEventType(aggregateType)
}
