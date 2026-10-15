import { z } from "zod"
import type { PrismaClient, Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { advance, claim, complete, fail, scan } from "../events/consumers"
import type { AccountingEvent, AccountingProvider } from "./provider"

const requestSchema = z.object({
  eventId: z.string(), providerId: z.string(), mappingRevision: z.string(),
  idempotencyKey: z.string(), method: z.literal("POST"), path: z.string().startsWith("/"), body: z.json(),
  expectedTotals: z.object({ net: z.string(), tax: z.string(), gross: z.string() }),
})
type Request = z.infer<typeof requestSchema>
type Prepared<S, P> = Extract<ReturnType<AccountingProvider<S, P>["map"]>, { status: "prepared" }>

/** Implementations must bound requests using the signal. Never put credentials in stored requests. */
export interface AccountingTransport {
  send(request: Request, signal: AbortSignal): Promise<{ status: number; externalRef?: string; retryAfterMs?: number }>
  /** absent must prove the prior attempt had no effect, including any still in flight. */
  reconcile(request: Request, signal: AbortSignal): Promise<
    { status: "delivered"; externalRef: string } | { status: "absent" } | { status: "unknown" }>
}
export interface AccountingConnections<S, P> {
  find(organizationId: string): Promise<{
    key: string // Immutable connection generation, changed when the remote account changes.
    mappingRevision: string
    provider: AccountingProvider<S, P>
    settings(event: AccountingEvent & { id: string }): Promise<S> // Frozen, event-specific evidence.
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
  await scan({ ...scope, interestedTypes: ["invoice.issued", "credit_note.issued", "payment.recorded"], limit: 100 }, db)
  await advance(scope, db)
  // Never pass an earlier failed, leased or delayed request. Sequence alone cannot ensure dependencies.
  const first = await db.eventConsumerDelivery.findFirst({
    where: { ...scope, status: { in: ["pending", "claimed", "failed"] } },
    orderBy: { sequence: "asc" },
  })
  if (!first) return "idle"
  if (first.status === "failed") return "failed"
  const [row] = await claim({ ...scope, sequence: first.sequence, now, limit: 1, leaseMs: 120_000 }, db)
  if (!row) return "idle"
  const fence = { id: row.id, status: "claimed" as const, claimToken: row.claimToken }
  const failure = async (code: string, retry = false, retryAfterMs = 0) => {
    if (!retry || row.attempts >= 5) {
      const result = await fail({ deliveryId: row.id, claimToken: row.claimToken, error: { code } }, db)
      return result.fenced ? "stale" : "failed"
    }
    const backoff = Math.min(60_000, 1000 * 2 ** (row.attempts - 1)) * (1 + Math.random())
    const delay = Math.max(backoff, Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0)
    const result = await db.eventConsumerDelivery.updateMany({
      where: fence,
      data: {
        status: "pending", availableAt: new Date(clock().getTime() + delay),
        error: { code }, claimToken: null, leaseUntil: null,
      },
    })
    return result.count ? "pending" : "stale"
  }
  const delivered = async (externalRef: string) => {
    const result = await complete({ deliveryId: row.id, claimToken: row.claimToken, externalRef }, db)
    if (result.fenced) return "stale"
    await advance(scope, db)
    return "delivered"
  }
  let request: Request
  try {
    if (row.prepared) request = requestSchema.parse(row.prepared)
    else {
      const event = await db.domainEvent.findUniqueOrThrow({
        where: { organizationId_sequence: { organizationId: scope.organizationId, sequence: row.sequence } },
      })
      const accountingEvent = { ...event, deliveryId: row.id }
      const mapped = connection.provider.map(accountingEvent, await connection.settings(accountingEvent))
      if (mapped.status === "refused") return failure(mapped.code)
      request = requestSchema.parse({
        eventId: event.id, providerId: connection.provider.id, method: "POST",
        mappingRevision: connection.mappingRevision, idempotencyKey: `${row.id}:request`,
        expectedTotals: mapped.expectedTotals, ...connection.request(mapped),
      })
      const pinned = await db.eventConsumerDelivery.updateMany({
        where: fence, data: { prepared: request as Prisma.InputJsonObject },
      })
      if (!pinned.count) return "stale"
    }
  } catch {
    return failure("preparation_failed")
  }
  try {
    if (row.attempts > 1) {
      const previous = await bounded(signal => input.transport.reconcile(request, signal))
      if (previous.status === "delivered") return delivered(previous.externalRef)
      if (previous.status !== "absent") return failure("reconciliation_required")
    }
    if (row.attempts > 5) return failure("attempts_exhausted")
    const response = await bounded(signal => input.transport.send(request, signal))
    if (response.status >= 200 && response.status < 300 && response.externalRef) return delivered(response.externalRef)
    const transient = response.status === 408 || response.status === 429 || response.status >= 500 || response.status < 300
    return failure(`http_${response.status}`, transient, response.retryAfterMs)
  } catch {
    return failure("transport_error", true)
  }
}
