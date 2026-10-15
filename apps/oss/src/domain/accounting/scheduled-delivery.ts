import { Prisma } from "../../../generated/prisma/client"
import { getAccountingDelivery } from "../../lib/runtime/services"
import { DEFAULT_ORGANIZATION_BUDGET, forEachOrganizationWithinBudget, organizationSqlFilter,
  registerTickTask, scannedOrganizationSource, type TickOptions, type OrganizationBudget } from "../scheduler"
import { accountingConnections } from "./connections"
import { deliverAccounting } from "./delivery"

export function accountingOrganizations(options?: TickOptions) {
  return scannedOrganizationSource("accounting", Prisma.sql`
    SELECT "organizationId" FROM "accounting_connection"
    WHERE "status" = 'connected' AND "credentialEnc" IS NOT NULL
    ${organizationSqlFilter(Prisma.sql`"organizationId"`, options)}
  `)
}

export async function runAccountingTick(_now = new Date(), options?: TickOptions,
  budget: OrganizationBudget = DEFAULT_ORGANIZATION_BUDGET): Promise<Record<string, number>> {
  const runtime = getAccountingDelivery()
  // No transport exists by default. Never claim events or manufacture failed deliveries without one.
  if (!runtime) return { disabled: 1 }
  const connections = accountingConnections(runtime)
  const outcomes: Record<string, number> = {}
  const result = await forEachOrganizationWithinBudget(accountingOrganizations(options), async organizationId => {
    try {
      const connection = await connections.find(organizationId)
      const outcome = connection ? await deliverAccounting({ organizationId,
        connections: { find: async () => connection }, transport: runtime.transport(connection.record) }) : "paused"
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
    } catch {
      // Provider errors can contain credentials. Only safe counts reach cron responses/logs.
      outcomes.failed = (outcomes.failed ?? 0) + 1
    }
  }, budget)
  return { ...outcomes, ...result }
}

registerTickTask({ name: "accounting", order: 50, run: runAccountingTick })
