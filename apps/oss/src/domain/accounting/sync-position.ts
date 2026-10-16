import { createHash } from "node:crypto"
import { z } from "zod"
import type { Prisma } from "../../../generated/prisma/client"
import type { ScanDisposition } from "../events/consumers"

export const reconnectReview = z.object({ code: z.literal("reconnect_review_required"), previousDeliveryId: z.string().optional(), accountFingerprint: z.string().optional() })
export function accountFingerprint(account: { provider: string; remoteAccountId: string }) {
  return createHash("sha256").update(JSON.stringify([account.provider, account.remoteAccountId])).digest("hex")
}

/** Prior successes and skips are terminal across providers and account generations. */
export async function accountingDispositions(scope: { organizationId: string; consumerKey: string },
  connection: { syncStartAt?: Date; reviewBefore?: Date | null; provider?: { supportsDelivery(type: string): boolean } },
  events: Array<{ sequence: number; occurredAt: Date; type: string; aggregateId: string }>, db: Prisma.TransactionClient) {
  const payments = events.filter(event => event.type === "payment.recorded")
  const excludedInvoices = new Set(payments.length && connection.syncStartAt ? (await db.domainEvent.findMany({
    where: { organizationId: scope.organizationId, type: "invoice.issued", occurredAt: { lt: connection.syncStartAt },
      aggregateId: { in: payments.map(event => event.aggregateId) } }, select: { aggregateId: true },
  })).map(event => event.aggregateId) : [])
  const previous = await db.eventConsumerDelivery.findMany({ where: { organizationId: scope.organizationId,
    consumerKey: { startsWith: "accounting:", not: scope.consumerKey }, sequence: { in: events.map(event => event.sequence) } }, orderBy: { updatedAt: "desc" } })
  return new Map<number, ScanDisposition>(events.map(event => {
    if (excludedInvoices.has(event.aggregateId) && event.type === "payment.recorded")
      return [event.sequence, { status: "skipped", error: { code: "invoice_before_sync_start" } }]
    if (connection.provider && !connection.provider.supportsDelivery(event.type))
      return [event.sequence, { status: "skipped", error: { code: "event_not_applicable" } }]
    const history = previous.filter(row => row.sequence === event.sequence)
    if (history.some(row => row.status === "done" || row.status === "skipped") ||
        connection.syncStartAt && event.occurredAt < connection.syncStartAt) return [event.sequence, { status: "skipped" }]
    const prior = history[0]
    if (prior || connection.reviewBefore && event.occurredAt < connection.reviewBefore)
      return [event.sequence, { status: "failed", error: { code: "reconnect_review_required", ...(prior ? { previousDeliveryId: reconnectReview.safeParse(prior.error).data?.previousDeliveryId ?? prior.id } : {}) } }]
    return [event.sequence, { status: "pending" }]
  }))
}
