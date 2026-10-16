import type { PostingEvent } from "./postings"

/** deliveryId is the existing EventConsumerDelivery.id, reused across attempts. */
export type AccountingEvent = PostingEvent & { deliveryId: string }
export type AccountingRefusal = { status: "refused"; code: string; detail: string }
type AccountingMapping<Payload> = AccountingRefusal | {
  status: "prepared"
  idempotencyKey: string
  payload: Payload
  expectedTotals: { net: string; tax: string; gross: string }
}

/** Pure preparation only. Transport, credentials and delivery state belong to the worker. */
export interface AccountingProvider<Settings, Payload> {
  readonly id: string
  supportsDelivery(type: string): boolean
  map(event: AccountingEvent, settings: Settings): AccountingMapping<Payload>
}

/** Payment v1 lacks the immutable evidence required for automatic delivery. */
export const supportsDocumentDelivery = (type: string) => type === "invoice.issued" || type === "credit_note.issued"
