/**
 * Consumer outbox. Use the delivery row's stable `id` as the remote idempotency key for every
 * external side effect. After a crash, look up that same id remotely before repeating the effect.
 * `scannedSequence` includes uninterested events; `acknowledgedSequence` includes only the
 * contiguous prefix of done or skipped deliveries. Failed deliveries stop acknowledgement.
 */
import { randomUUID } from "node:crypto"
import { Prisma, type PrismaClient } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { upcastEvent } from "./upcast"

type Db = PrismaClient | Prisma.TransactionClient
type Consumer = { organizationId: string; consumerKey: string }

export class EventConsumerCursorConflict extends Error {
  override readonly name = "EventConsumerCursorConflict"
  constructor() { super("Consumer cursor changed; retry the transaction") }
}

function transaction<T>(db: Db, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return "$transaction" in db ? db.$transaction(work) : work(db)
}

function batchLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("limit must be an integer from 1 to 1000")
  return limit
}

async function cursor(tx: Prisma.TransactionClient, input: Consumer) {
  return tx.eventConsumerCursor.upsert({
    where: { organizationId_consumerKey: input }, create: input, update: {},
  })
}

/** Call inside a transaction. A conflict must roll back its delivery inserts as well. */
export async function scan(input: Consumer & { interestedTypes: readonly string[]; limit: number }, db: Db = prisma) {
  const limit = batchLimit(input.limit)
  const scope = { organizationId: input.organizationId, consumerKey: input.consumerKey }
  return transaction(db, async (tx) => {
    const current = await cursor(tx, scope)
    const events = await tx.domainEvent.findMany({
      where: { organizationId: input.organizationId, sequence: { gt: current.scannedSequence } },
      orderBy: { sequence: "asc" }, take: limit,
    })
    if (events.length === 0) return current
    const interested = new Set(input.interestedTypes)
    await tx.eventConsumerDelivery.createMany({
      data: events.map((event) => ({ ...scope, sequence: event.sequence, status: interested.has(event.type) ? "pending" : "skipped" })),
      skipDuplicates: true,
    })
    const scannedSequence = events.at(-1)!.sequence
    const changed = await tx.eventConsumerCursor.updateMany({
      where: { id: current.id, version: current.version },
      data: { scannedSequence, version: { increment: 1 } },
    })
    if (changed.count !== 1) throw new EventConsumerCursorConflict()
    return { ...current, scannedSequence, version: current.version + 1 }
  })
}

export async function claim(input: Consumer & { limit: number; leaseMs: number; now: Date }, db: Db = prisma) {
  const limit = batchLimit(input.limit)
  if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0 || !Number.isFinite(input.now.getTime())) throw new RangeError("Invalid lease or time")
  const leaseUntil = new Date(input.now.getTime() + input.leaseMs)
  if (!Number.isFinite(leaseUntil.getTime())) throw new RangeError("Invalid lease end")
  const eligible: Prisma.EventConsumerDeliveryWhereInput = {
    organizationId: input.organizationId, consumerKey: input.consumerKey,
    OR: [{ status: "pending" }, { status: "claimed", leaseUntil: { lte: input.now } }],
  }
  return transaction(db, async (tx) => {
    const candidates = await tx.eventConsumerDelivery.findMany({ where: eligible, orderBy: { sequence: "asc" }, take: limit })
    const rows = []
    for (const row of candidates) {
      const claimToken = randomUUID()
      const changed = await tx.eventConsumerDelivery.updateMany({
        where: { ...eligible, id: row.id },
        data: { status: "claimed", claimToken, leaseUntil, attempts: { increment: 1 } },
      })
      if (changed.count === 1) rows.push({ ...row, status: "claimed" as const, claimToken, leaseUntil, attempts: row.attempts + 1 })
    }
    return rows
  })
}

export async function complete(input: { deliveryId: string; claimToken: string; externalRef?: string }, db: Db = prisma) {
  const changed = await db.eventConsumerDelivery.updateMany({
    where: { id: input.deliveryId, status: "claimed", claimToken: input.claimToken },
    data: { status: "done", externalRef: input.externalRef, error: Prisma.DbNull, claimToken: null, leaseUntil: null },
  })
  return { fenced: changed.count === 0 }
}

export async function fail(input: { deliveryId: string; claimToken: string; error: Prisma.InputJsonValue }, db: Db = prisma) {
  const changed = await db.eventConsumerDelivery.updateMany({
    where: { id: input.deliveryId, status: "claimed", claimToken: input.claimToken },
    data: { status: "failed", error: input.error, claimToken: null, leaseUntil: null },
  })
  return { fenced: changed.count === 0 }
}

/** Gaps and failed, pending or claimed deliveries stop the contiguous acknowledged prefix. */
export async function advance(input: Consumer, db: Db = prisma) {
  return transaction(db, async (tx) => {
    const current = await cursor(tx, input)
    const rows = await tx.eventConsumerDelivery.findMany({
      where: { ...input, sequence: { gt: current.acknowledgedSequence, lte: current.scannedSequence } },
      orderBy: { sequence: "asc" }, select: { sequence: true, status: true },
    })
    let acknowledgedSequence = current.acknowledgedSequence
    for (const row of rows) {
      if (row.sequence !== acknowledgedSequence + 1 || (row.status !== "done" && row.status !== "skipped")) break
      acknowledgedSequence = row.sequence
    }
    if (acknowledgedSequence === current.acknowledgedSequence) return current
    const changed = await tx.eventConsumerCursor.updateMany({
      where: { id: current.id, version: current.version },
      data: { acknowledgedSequence, version: { increment: 1 } },
    })
    if (changed.count !== 1) throw new EventConsumerCursorConflict()
    return { ...current, acknowledgedSequence, version: current.version + 1 }
  })
}

/** Filtering is for reads only; consumers must use the unfiltered scan to track skipped events. */
export async function readEvents(input: { organizationId: string; afterSequence: number; types?: readonly string[]; limit: number; upcast?: boolean }, db: Db = prisma) {
  const rows = await db.domainEvent.findMany({
    where: { organizationId: input.organizationId, sequence: { gt: input.afterSequence }, ...(input.types ? { type: { in: [...input.types] } } : {}) },
    orderBy: { sequence: "asc" }, take: batchLimit(input.limit),
  })
  return input.upcast ? rows.map((row) => upcastEvent(row)) : rows
}
