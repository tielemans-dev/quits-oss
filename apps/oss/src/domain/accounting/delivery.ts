import { z } from "zod"
import type { PrismaClient, Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { advance, claim, complete, fail, scan } from "../events/consumers"
import type { AccountingEvent, AccountingProvider } from "./provider"
import { accountingDispositions } from "./sync-position"
import { mappingContextSchema, type MappingContext } from "./mappings"
import { equalTotals, fingerprint, payloadTotalsMatch, totalsSchema, type Totals } from "./safeguards"

const safeguardMessages: Record<string, string> = {
  payload_totals_mismatch: "The accounting payload totals differ from the source document. Nothing was sent. Review this delivery.",
  provider_totals_mismatch: "The accounting provider reported different totals. Review the remote document before retrying.",
  source_review_required: "The source document changed or its first-attempt evidence is missing. Review this delivery before sending.",
}

const requestSchema = mappingContextSchema.extend({
  eventId: z.string(), providerId: z.string(),
  idempotencyKey: z.string(), method: z.literal("POST"), path: z.string().startsWith("/"), body: z.json(),
  expectedTotals: z.object({ net: z.string(), tax: z.string(), gross: z.string() }),
})
type Request = z.infer<typeof requestSchema>
type Prepared<S, P> = Extract<ReturnType<AccountingProvider<S, P>["map"]>, { status: "prepared" }>

/** Bound requests using the signal. Never put credentials in stored requests.
 * Totals are decimal DKK strings, signed for credits, read from the provider, never echoed from the request. */
export interface AccountingTransport {
  send(request: Request, signal: AbortSignal): Promise<{ status: number; externalRef?: string; totals?: Totals; retryAfterMs?: number }>
  /** absent must prove the prior attempt had no effect, including any still in flight. */
  reconcile(request: Request, signal: AbortSignal): Promise<
    { status: "delivered"; externalRef: string; totals?: Totals } | { status: "absent" } | { status: "unknown" }>
}
export interface AccountingConnections<S, P> {
  find(organizationId: string): Promise<{
    key: string // Immutable connection generation, changed when the remote account changes.
    syncStartAt?: Date
    reviewBefore?: Date | null
    isCurrent?(): Promise<boolean>
    mappingRevision: string
    provider: AccountingProvider<S, P>
    resolveMapping?(event: AccountingEvent & { id: string }): Promise<MappingContext>
    settings(event: AccountingEvent & { id: string }, mapping?: MappingContext): Promise<S> // Frozen, event-specific evidence.
    request(prepared: Prepared<S, P>): { path: string; body: Prisma.InputJsonValue }
  } | null>
}

async function bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error("Accounting transport timeout"))
        }, 30_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function retryAvailableAt(now: Date, retryAfterMs: number, backoffMs: number) {
  const base = Number.isFinite(now.getTime()) ? now.getTime() : Date.now()
  const delay = Math.max(backoffMs, Number.isFinite(retryAfterMs) ? Math.max(0, Math.min(86_400_000, retryAfterMs)) : 0)
  return new Date(Math.min(8.64e15, base + delay))
}

/** One prepared request per event. Delivered means accepted draft/payment, never booked sales. */
export async function deliverAccounting<S, P>(input: {
  organizationId: string
  connections: AccountingConnections<S, P>
  transport: AccountingTransport
  clock?: () => Date
}, db: PrismaClient = prisma) {
  const clock = input.clock ?? (() => new Date())
  const now = clock()
  const connection = await input.connections.find(input.organizationId)
  if (!connection) return "paused"
  const scope = {
    organizationId: input.organizationId,
    consumerKey: `accounting:${connection.provider.id}:${connection.key}`,
  }
  await scan({ ...scope, interestedTypes: ["invoice.issued", "credit_note.issued", "payment.recorded"], limit: 100,
    dispositions: (events, tx) => accountingDispositions(scope, connection, events, tx) }, db)
  await advance(scope, db)
  // Never pass an earlier failed, leased or delayed request. Sequence alone cannot ensure dependencies.
  const first = await db.eventConsumerDelivery.findFirst({
    where: { ...scope, status: { in: ["pending", "claimed", "failed"] } },
    orderBy: { sequence: "asc" },
  })
  if (!first) return "idle"
  const firstEvent = await db.domainEvent.findUniqueOrThrow({ where: { organizationId_sequence: { organizationId: scope.organizationId, sequence: first.sequence } } })
  if (!connection.provider.supportsDelivery(firstEvent.type) || firstEvent.type === "payment.recorded") {
    const disposition = (await accountingDispositions(scope, connection, [firstEvent], db)).get(first.sequence)
    if (disposition?.status === "skipped") {
      await db.eventConsumerDelivery.updateMany({ where: { id: first.id, status: first.status, claimToken: first.claimToken },
        data: { ...disposition, claimToken: null, leaseUntil: null } })
      await advance(scope, db)
      return "skipped"
    }
  }
  if (first.status === "failed") return "failed"
  const [row] = await claim({ ...scope, sequence: first.sequence, now, limit: 1, leaseMs: 120_000 }, db)
  if (!row) return "idle"
  const fence = { id: row.id, status: "claimed" as const, claimToken: row.claimToken }
  const failure = async (code: string, retry = false, retryAfterMs = 0) => {
    if (!retry || row.attempts >= 5) {
      const result = await fail({ deliveryId: row.id, claimToken: row.claimToken,
        error: { code, ...(safeguardMessages[code] ? { message: safeguardMessages[code] } : {}) } }, db)
      return result.fenced ? "stale" : "failed"
    }
    const backoff = Math.min(60_000, 1000 * 2 ** (row.attempts - 1)) * (1 + Math.random())
    const result = await db.eventConsumerDelivery.updateMany({
      where: fence,
      data: {
        status: "pending", availableAt: retryAvailableAt(clock(), retryAfterMs, backoff),
        error: { code }, claimToken: null, leaseUntil: null,
      },
    })
    return result.count ? "pending" : "stale"
  }
  const delivered = async (externalRef: string, totals?: Totals) => {
    const reported = totalsSchema.safeParse(totals)
    const saved = await db.eventConsumerDelivery.updateMany({ where: fence,
      data: { externalRef, response: { externalRef, totals: reported.success ? reported.data : null } } })
    if (!saved.count) return "stale"
    if (!reported.success) return failure("reconciliation_required")
    if (!equalTotals(request.expectedTotals, reported.data)) return failure("provider_totals_mismatch")
    const result = await complete({ deliveryId: row.id, claimToken: row.claimToken, externalRef }, db)
    if (result.fenced) return "stale"
    await advance(scope, db)
    return "delivered"
  }
  let request: Request
  try {
    const event = await db.domainEvent.findUniqueOrThrow({
      where: { organizationId_sequence: { organizationId: scope.organizationId, sequence: row.sequence } },
    })
    const source = { type: event.type, schemaVersion: event.schemaVersion, payload: event.payload }
    // Ignore payment/email status updates, but detect changed issued content and financial lines.
    const select = { number: true, currency: true, issueDate: true, issuanceSnapshot: true,
      subtotalNet: true, totalTax: true, totalGross: true, buyerSnapshot: true, sellerSnapshot: true,
      items: { orderBy: { id: "asc" as const } } } as const
    const identity = z.object({ documentId: z.string() }).safeParse(event.payload)
    const where = { organizationId: scope.organizationId, id: identity.success ? identity.data.documentId : event.aggregateId }
    const document = event.type === "invoice.issued" ? await db.invoice.findFirst({ where, select: { ...select, editRevision: true, dueDate: true } })
      : event.type === "credit_note.issued" ? await db.creditNote.findFirst({ where, select: { ...select, reason: true } }) : null
    const hash = fingerprint({ source, document })
    if (row.evidence ? z.object({ hash: z.string() }).parse(row.evidence).hash !== hash : row.prepared || row.attempts > 1)
      return failure("source_review_required")
    if (!row.evidence) {
      const pinned = await db.eventConsumerDelivery.updateMany({ where: fence, data: { evidence: { hash, source } } })
      if (!pinned.count) return "stale"
    }
    if (row.prepared) request = requestSchema.parse(row.prepared)
    else {
      const accountingEvent = { ...event, deliveryId: row.id }
      const mapping = await connection.resolveMapping?.(accountingEvent) ?? { mappingRevision: connection.mappingRevision }
      const mapped = connection.provider.map(accountingEvent, await connection.settings(accountingEvent, mapping))
      if (mapped.status === "refused") return failure(mapped.code)
      request = requestSchema.parse({
        eventId: event.id, providerId: connection.provider.id, method: "POST",
        ...mapping, idempotencyKey: `${row.id}:request`,
        expectedTotals: mapped.expectedTotals, ...connection.request(mapped),
      })
      const pinned = await db.eventConsumerDelivery.updateMany({
        where: fence, data: { prepared: request as Prisma.InputJsonObject },
      })
      if (!pinned.count) return "stale"
    }
    if (!payloadTotalsMatch({ ...source, deliveryId: row.id }, request)) return failure("payload_totals_mismatch")
  } catch {
    return failure("preparation_failed")
  }
  try {
    if (connection.isCurrent && !await connection.isCurrent()) return failure("reconnect_review_required")
    // Manual retry resets the send budget, but a pinned request still needs reconciliation.
    if (row.attempts > 1 || row.prepared) {
      const previous = await bounded(signal => input.transport.reconcile(request, signal))
      if (previous.status === "delivered") return delivered(previous.externalRef, previous.totals)
      if (previous.status !== "absent") return failure("reconciliation_required")
      if (row.externalRef) return failure("reconciliation_required")
    }
    if (row.attempts > 5) return failure("attempts_exhausted")
    if (connection.isCurrent && !await connection.isCurrent()) return failure("reconnect_review_required")
    const response = await bounded(signal => input.transport.send(request, signal))
    if (response.status >= 200 && response.status < 300 && response.externalRef) return delivered(response.externalRef, response.totals)
    const transient = response.status === 408 || response.status === 429 || response.status >= 500 || response.status < 300
    return failure(`http_${response.status}`, transient, response.retryAfterMs)
  } catch {
    return failure("transport_error", true)
  }
}
