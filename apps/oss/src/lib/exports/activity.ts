import type { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../db"

export type ActivityDocumentType = "invoice" | "quote" | "creditNote" | "agreement"

/** Payload keys that link an event on another aggregate (payment, credit note) to a document. */
const DOCUMENT_PAYLOAD_KEYS: Record<ActivityDocumentType, string> = {
  agreement: "agreementId",
  invoice: "invoiceId",
  quote: "quoteId",
  creditNote: "creditNoteId",
}

type EventRow = {
  sequence: number
  aggregateType: string
  aggregateId: string
  type: string
  schemaVersion: number
  payload: unknown
  actor: { kind: string; id: string | null; label: string | null }
  approvedByUserId: string | null
  commandId: string | null
  occurredAt: string
}

export type ActivityEntry = {
  sequence: number
  aggregateType: string
  aggregateId: string
  type: string
  schemaVersion: number
  payload: Record<string, unknown>
  actor: { kind: string; id: string | null; label: string | null; name: string | null }
  approvedBy: { id: string; name: string | null } | null
  commandId: string | null
  occurredAt: string
}

function toRow(row: {
  sequence: number
  aggregateType: string
  aggregateId: string
  type: string
  schemaVersion: number
  payload: Prisma.JsonValue
  actorKind: string
  actorId: string | null
  actorLabel: string | null
  approvedByUserId: string | null
  commandId: string | null
  occurredAt: Date
}): EventRow {
  return {
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
  }
}

/** Resolves user display names for user actors and approvers in one query. */
async function withActorNames(organizationId: string, events: EventRow[]): Promise<ActivityEntry[]> {
  const userIds = new Set<string>()
  for (const event of events) {
    if (event.actor.kind === "user" && event.actor.id) userIds.add(event.actor.id)
    if (event.approvedByUserId) userIds.add(event.approvedByUserId)
  }
  const users =
    userIds.size === 0
      ? []
      : await prisma.member.findMany({
          where: { organizationId, userId: { in: [...userIds] } },
          select: { userId: true, user: { select: { name: true, email: true } } },
        })
  const names = new Map(users.map((member) => [member.userId, member.user.name || member.user.email]))

  return events.map((event) => ({
    sequence: event.sequence,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    type: event.type,
    schemaVersion: event.schemaVersion,
    payload:
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {},
    actor: {
      ...event.actor,
      name: event.actor.kind === "user" && event.actor.id ? (names.get(event.actor.id) ?? null) : null,
    },
    approvedBy: event.approvedByUserId
      ? { id: event.approvedByUserId, name: names.get(event.approvedByUserId) ?? null }
      : null,
    commandId: event.commandId,
    occurredAt: event.occurredAt,
  }))
}

/** Stored aggregate type spellings for a filter value; camelCase and snake_case both occur. */
export function aggregateTypeAliases(aggregateType: string): string[] {
  const snake = aggregateType.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  const camel = aggregateType.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
  return [...new Set([aggregateType, snake, camel])]
}

export type ActivityPageQuery = {
  organizationId: string
  /** Oldest first, after this sequence (the agent cursor, as in `readActivity`). */
  afterSequence?: number
  /** Newest first, before this sequence (the audit log "load more" cursor). */
  beforeSequence?: number
  order?: "asc" | "desc"
  aggregateType?: string
  aggregateId?: string
  limit?: number
}

/**
 * A page of the organization's event log with actor names resolved. Ascending pages follow
 * `afterSequence` like `readActivity`; descending pages (or any `beforeSequence` query) walk
 * backwards from the newest event.
 */
export async function listActivity(query: ActivityPageQuery) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const descending = query.order === "desc" || query.beforeSequence !== undefined
  const sequence = {
    ...(query.afterSequence !== undefined ? { gt: query.afterSequence } : {}),
    ...(query.beforeSequence !== undefined ? { lt: query.beforeSequence } : {}),
  }

  const rows = await prisma.domainEvent.findMany({
    where: {
      organizationId: query.organizationId,
      ...(Object.keys(sequence).length > 0 ? { sequence } : {}),
      ...(query.aggregateType ? { aggregateType: { in: aggregateTypeAliases(query.aggregateType) } } : {}),
      ...(query.aggregateId ? { aggregateId: query.aggregateId } : {}),
    },
    orderBy: { sequence: descending ? "desc" : "asc" },
    take: limit + 1,
  })
  const page = rows.slice(0, limit)
  const cursor = descending ? query.beforeSequence : query.afterSequence
  return {
    events: await withActorNames(query.organizationId, page.map(toRow)),
    nextSequence: page.at(-1)?.sequence ?? cursor ?? 0,
    hasMore: rows.length > limit,
  }
}

/**
 * The timeline of one document, oldest first: its own events plus events on related aggregates
 * (payments, credit notes) whose payload references it.
 */
export async function documentActivity(input: {
  organizationId: string
  documentType: ActivityDocumentType
  documentId: string
  limit?: number
}) {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500)
  const rows = await prisma.domainEvent.findMany({
    where: {
      organizationId: input.organizationId,
      OR: [
        {
          aggregateType: { in: aggregateTypeAliases(input.documentType) },
          aggregateId: input.documentId,
        },
        { payload: { path: [DOCUMENT_PAYLOAD_KEYS[input.documentType]], equals: input.documentId } },
      ],
    },
    orderBy: { sequence: "asc" },
    take: limit,
  })
  return { events: await withActorNames(input.organizationId, rows.map(toRow)) }
}
