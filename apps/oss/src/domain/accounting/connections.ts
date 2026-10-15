import { randomUUID } from "node:crypto"
import type { Prisma, PrismaClient, AccountingProviderId } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { encryptSecret } from "../../lib/secrets"
import { dineroProvider, type DineroSettings } from "./dinero"
import { economicProvider, type EconomicSettings } from "./economic"
import type { AccountingConnections, AccountingTransport } from "./delivery"
import type { AccountingEvent, AccountingProvider } from "./provider"

export type ConnectionInfo = {
  organizationId: string; generation: string; provider: AccountingProviderId
  remoteAccountId: string; mappingRevision: string
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
  credential: string; mappingRevision: string
}, db: PrismaClient = prisma): Promise<void> {
  if (![input.remoteAccountId, input.credential, input.mappingRevision].every(value => value.trim()))
    throw new Error("Incomplete accounting connection")
  const data = { provider: input.provider, remoteAccountId: input.remoteAccountId, mappingRevision: input.mappingRevision,
    generation: randomUUID(), status: "connected" as const, credentialEnc: encryptSecret(input.credential) }
  await db.accountingConnection.upsert({ where: { organizationId: input.organizationId },
    create: { organizationId: input.organizationId, ...data }, update: data })
}

/** Pauses delivery and removes local authorization. Remote revocation belongs to the future OAuth flow. */
export async function disconnectAccounting(organizationId: string, db: PrismaClient | Prisma.TransactionClient = prisma): Promise<void> {
  await db.accountingConnection.updateMany({ where: { organizationId }, data: { status: "disconnected", credentialEnc: null } })
}

export function accountingConnections(runtime: AccountingDeliveryRuntime, db: PrismaClient = prisma) {
  return {
    async find(organizationId: string) {
      const record = await db.accountingConnection.findFirst({
        where: { organizationId, status: "connected", credentialEnc: { not: null } },
        select: { organizationId: true, generation: true, provider: true, remoteAccountId: true, mappingRevision: true },
      })
      if (!record) return null
      const provider: AccountingProvider<Settings, Payload> = {
        id: record.provider,
        map(event, settings) {
          if (settings.provider !== record.provider) return { status: "refused", code: "provider_mismatch", detail: "Settings must match the connection" }
          if (settings.provider === "dinero") return dineroProvider.map(event, settings.value)
          const mapped = economicProvider.map(event, settings.value)
          return mapped.status === "refused" ? mapped : { ...mapped, payload: { path: "/invoices/drafts", body: mapped.payload } }
        },
      }
      return { record, key: record.generation, mappingRevision: record.mappingRevision, provider,
        settings: (event: AccountingEvent & { id: string }) => runtime.settings(record, event),
        request: (prepared: Extract<ReturnType<typeof provider.map>, { status: "prepared" }>) => prepared.payload }
    },
  } satisfies AccountingConnections<Settings, Payload>
}
