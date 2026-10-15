import type { AccountingProviderId, PrismaClient } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"

export const ACCOUNTING_PROVIDER_IDS = ["economic", "dinero"] as const satisfies readonly AccountingProviderId[]

/** "error" is derived: a connection with a failed delivery. The stored status is connected or disconnected. */
export type AccountingProviderStatus = {
  provider: AccountingProviderId
  status: "not_connected" | "connected" | "error"
  remoteAccountId: string | null
  delivery: { lastDeliveredAt: Date | null; failedCount: number; lastErrorCode: string | null } | null
}

/**
 * Connection and recent delivery state for each provider. One organization has at most one
 * connection, so the other provider is not connected. Never selects the credential.
 */
export async function readAccountingStatus(organizationId: string, db: PrismaClient = prisma): Promise<AccountingProviderStatus[]> {
  const connection = await db.accountingConnection.findFirst({
    where: { organizationId, status: "connected", credentialEnc: { not: null } },
    select: { provider: true, generation: true, remoteAccountId: true },
  })
  const delivery = connection ? await readDelivery(organizationId, `accounting:${connection.provider}:${connection.generation}`, db) : null
  return ACCOUNTING_PROVIDER_IDS.map(provider => provider === connection?.provider
    ? { provider, status: delivery && delivery.failedCount > 0 ? "error" : "connected", remoteAccountId: connection.remoteAccountId, delivery }
    : { provider, status: "not_connected", remoteAccountId: null, delivery: null })
}

async function readDelivery(organizationId: string, consumerKey: string, db: PrismaClient) {
  const scope = { organizationId, consumerKey }
  const newest = { orderBy: { updatedAt: "desc" as const }, select: { updatedAt: true, error: true } }
  const [delivered, failedCount, failed] = await Promise.all([
    db.eventConsumerDelivery.findFirst({ where: { ...scope, status: "done" }, ...newest }),
    db.eventConsumerDelivery.count({ where: { ...scope, status: "failed" } }),
    db.eventConsumerDelivery.findFirst({ where: { ...scope, status: "failed" }, ...newest }),
  ])
  const code = (failed?.error as { code?: unknown } | null)?.code
  return { lastDeliveredAt: delivered?.updatedAt ?? null, failedCount, lastErrorCode: typeof code === "string" ? code : null }
}
