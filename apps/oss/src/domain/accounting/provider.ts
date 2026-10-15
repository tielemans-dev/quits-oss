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
  map(event: AccountingEvent, settings: Settings): AccountingMapping<Payload>
}
