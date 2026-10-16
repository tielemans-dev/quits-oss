import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Prisma, type PrismaClient, type AccountingProviderId } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { encryptSecret } from "../../lib/secrets"
import { actorCan, type Actor } from "../actor"
import { appendEvents } from "../events"
import type { PendingEvent } from "../services"
import { accountFingerprint, reconnectReview } from "./sync-position"
import { dineroProvider, type DineroSettings } from "./dinero"
import { economicProvider, type EconomicSettings } from "./economic"
import type { AccountingConnections, AccountingTransport } from "./delivery"
import type { AccountingEvent, AccountingProvider } from "./provider"
import { mappingContextSchema, readStoredMappings, type AccountingMappings, type MappingContext } from "./mappings"

export type ConnectionInfo = {
  organizationId: string; generation: string; provider: AccountingProviderId
  remoteAccountId: string; mappingRevision: string
  mappings?: AccountingMappings // Saved chart configuration; validate remote relationships before resolving settings.
}
type Settings = { provider: "economic"; value: EconomicSettings } | { provider: "dinero"; value: DineroSettings }
type Payload = { path: string; body: Prisma.InputJsonValue }
export type AccountingDeliveryRuntime = {
  /** Resolve immutable evidence for this event and connection, never credentials. */
  settings: (connection: ConnectionInfo, event: AccountingEvent & { id: string }) => Promise<Settings>
  transport: (connection: ConnectionInfo) => AccountingTransport
}

/** Server-only entry point for a future authorization flow. Every authorization starts a new generation. */
export async function connectAccounting(input: {
  organizationId: string; provider: AccountingProviderId; remoteAccountId: string
  credential: string; mappingRevision: string; syncStartAt?: Date
  actor: Actor
}, db: PrismaClient = prisma): Promise<void> {
  if (input.actor.organizationId !== input.organizationId || !actorCan(input.actor, "settings:update")) throw new Error("Accounting connection not authorized")
  if (![input.remoteAccountId, input.credential, input.mappingRevision].every(value => value.trim()))
    throw new Error("Incomplete accounting connection")
  const now = new Date()
  if (input.syncStartAt && !Number.isFinite(input.syncStartAt.getTime())) throw new Error("Invalid sync start date")
  const data = { provider: input.provider, remoteAccountId: input.remoteAccountId, mappingRevision: input.mappingRevision,
    generation: randomUUID(), status: "connected" as const, credentialEnc: encryptSecret(input.credential) }
  await db.$transaction(async tx => {
    const events: PendingEvent[] = []
    const previous = await tx.accountingConnection.findUnique({ where: { organizationId: input.organizationId } })
    if (previous) {
      const rows = await tx.eventConsumerDelivery.findMany({ where: { organizationId: input.organizationId,
        consumerKey: `accounting:${previous.provider}:${previous.generation}`, status: { in: ["pending", "failed", "claimed"] } } })
      for (const row of rows) {
        await tx.eventConsumerDelivery.update({ where: { id: row.id }, data: {
          status: "failed", claimToken: null, leaseUntil: null, error: { code: "reconnect_review_required",
            accountFingerprint: accountFingerprint(previous), previousError: row.error,
            ...(reconnectReview.safeParse(row.error).success ? row.error as Prisma.JsonObject : {}) },
        } })
        events.push({ aggregateType: "organization", aggregateId: input.organizationId, type: "accounting.action_recorded",
          payload: { action: "reconnect_hold", provider: previous.provider, generation: previous.generation, deliveryId: row.id, reason: "reconnect_review_required" } })
      }
    }
    await tx.accountingConnection.upsert({ where: { organizationId: input.organizationId },
      create: { organizationId: input.organizationId, ...data, syncStartAt: input.syncStartAt ?? now },
      update: { ...data, reviewBefore: now, ...(previous && (previous.provider !== input.provider || previous.remoteAccountId !== input.remoteAccountId) ? { mappings: Prisma.DbNull } : {}) } }) // The first start position survives reconnection.
    events.push({ aggregateType: "organization", aggregateId: input.organizationId, type: "accounting.action_recorded",
      payload: { action: previous ? "reconnect" : "connect", provider: input.provider, generation: data.generation, deliveryId: null, reason: null } })
    await appendEvents(tx, { organizationId: input.organizationId, actor: input.actor, commandId: null,
      approvedByUserId: null, occurredAt: now, events })
  }, { isolationLevel: "Serializable" })
}

/** Pauses delivery and removes local authorization. Remote revocation belongs to the future OAuth flow. */
export async function disconnectAccounting(organizationId: string, db: PrismaClient | Prisma.TransactionClient = prisma): Promise<void> {
  await db.accountingConnection.updateMany({ where: { organizationId }, data: { status: "disconnected", credentialEnc: null } })
}

export function accountingConnections(runtime: AccountingDeliveryRuntime, db: PrismaClient = prisma) {
  return {
    async find(organizationId: string) {
      const stored = await db.accountingConnection.findFirst({
        where: { organizationId, status: "connected", credentialEnc: { not: null } },
        select: { organizationId: true, generation: true, provider: true, remoteAccountId: true, mappingRevision: true, syncStartAt: true, reviewBefore: true, mappings: true },
      })
      if (!stored) return null
      const decoded = readStoredMappings(stored.mappings)
      const record = { ...stored, ...decoded, mappings: stored.mappings === null ? undefined : decoded.mappings }
      const provider: AccountingProvider<Settings, Payload> = {
        id: record.provider,
        supportsDelivery: (record.provider === "dinero" ? dineroProvider : economicProvider).supportsDelivery,
        map(event, settings) {
          if (settings.provider !== record.provider) return { status: "refused", code: "provider_mismatch", detail: "Settings must match the connection" }
          if (settings.provider === "dinero") return dineroProvider.map(event, settings.value)
          const mapped = economicProvider.map(event, settings.value)
          return mapped.status === "refused" ? mapped : { ...mapped, payload: { path: "/invoices/drafts", body: mapped.payload } }
        },
      }
      return { record, key: record.generation, syncStartAt: record.syncStartAt, reviewBefore: record.reviewBefore,
        isCurrent: async () => !!await db.accountingConnection.findFirst({ where: { organizationId, generation: record.generation, status: "connected", credentialEnc: { not: null } }, select: { organizationId: true } }), mappingRevision: record.mappingRevision, provider,
        resolveMapping: async (event: AccountingEvent & { id: string }): Promise<MappingContext> => {
          const fingerprint = accountFingerprint(record)
          if (event.type !== "credit_note.issued") return { mappingRevision: record.mappingRevision, mappings: record.mappings, accountFingerprint: fingerprint }
          const { correctsInvoiceId } = z.object({ correctsInvoiceId: z.string() }).parse(event.payload)
          const original = await db.domainEvent.findFirstOrThrow({ where: { organizationId, type: "invoice.issued", aggregateId: correctsInvoiceId } })
          const delivery = await db.eventConsumerDelivery.findFirstOrThrow({ where: { organizationId, sequence: original.sequence, status: "done",
            consumerKey: { startsWith: `accounting:${record.provider}:` }, prepared: { path: ["accountFingerprint"], equals: fingerprint } }, orderBy: { updatedAt: "desc" } })
          return mappingContextSchema.parse(delivery.prepared)
        },
        settings: async (event: AccountingEvent & { id: string }, mapping?: MappingContext) => {
          if ((!mapping || mapping.mappingRevision === record.mappingRevision) && record.mappingsInvalid) throw new Error("Invalid stored accounting mappings")
          return runtime.settings(mapping ? { ...record, mappingRevision: mapping.mappingRevision, mappings: mapping.mappings } : record, event)
        },
        request: (prepared: Extract<ReturnType<typeof provider.map>, { status: "prepared" }>) => prepared.payload }
    },
  } satisfies AccountingConnections<Settings, Payload>
}
