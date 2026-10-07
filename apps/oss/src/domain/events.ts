import type { Prisma } from "../../generated/prisma/client"
import { prisma } from "../lib/db"
import { actorId, type Actor } from "./actor"
import { serializeEvent } from "./events/registry"
import type { PendingEvent } from "./services"

/**
 * Appends events with a per-organization monotonic sequence. Incrementing the counter row
 * serializes writers within an organization, so sequences never interleave or repeat.
 */
export async function appendEvents(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    actor: Actor
    commandId: string | null
    approvedByUserId: string | null
    occurredAt: Date
    events: PendingEvent[]
  }
) {
  if (input.events.length === 0) {
    return
  }

  const events = input.events.map((event) => ({ ...event, ...serializeEvent(event.type, event.payload) }))

  const { eventSequence: last } = await tx.orgSettings.upsert({
    where: { organizationId: input.organizationId },
    create: { organizationId: input.organizationId, eventSequence: input.events.length },
    update: { eventSequence: { increment: input.events.length } },
    select: { eventSequence: true },
  })
  const first = last - input.events.length + 1

  await tx.domainEvent.createMany({
    data: events.map((event, index) => ({
      organizationId: input.organizationId,
      sequence: first + index,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      type: event.type,
      payload: event.payload as Prisma.InputJsonValue,
      schemaVersion: event.schemaVersion,
      actorKind: input.actor.kind,
      actorId: actorId(input.actor),
      actorLabel: input.actor.label,
      approvedByUserId: input.approvedByUserId,
      commandId: input.commandId,
      occurredAt: input.occurredAt,
    })),
  })
}

export type ActivityQuery = {
  organizationId: string
  afterSequence?: number
  aggregateType?: string
  aggregateId?: string
  limit?: number
}

export async function readActivity(query: ActivityQuery) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const rows = await prisma.domainEvent.findMany({
    where: {
      organizationId: query.organizationId,
      ...(query.afterSequence !== undefined ? { sequence: { gt: query.afterSequence } } : {}),
      ...(query.aggregateType ? { aggregateType: query.aggregateType } : {}),
      ...(query.aggregateId ? { aggregateId: query.aggregateId } : {}),
    },
    orderBy: { sequence: "asc" },
    take: limit + 1,
  })

  const page = rows.slice(0, limit)
  return {
    events: page.map((row) => ({
      sequence: row.sequence,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      type: row.type,
      schemaVersion: row.schemaVersion,
      payload: row.payload,
      actor: { kind: row.actorKind, id: row.actorId, label: row.actorLabel },
      approvedByUserId: row.approvedByUserId,
      commandId: row.commandId,
      occurredAt: row.occurredAt.toISOString(),
    })),
    nextSequence: page.at(-1)?.sequence ?? query.afterSequence ?? 0,
    hasMore: rows.length > limit,
  }
}
