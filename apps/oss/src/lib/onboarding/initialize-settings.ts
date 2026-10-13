import type { Prisma } from "../../../generated/prisma/client"
import { buildDkSettingsDefaults } from "./dk-presets"

/** PostgreSQL skips a concurrent insert on organizationId without changing saved settings. */
export async function initializeDkSettings(organizationId: string, db: Prisma.TransactionClient) {
  await db.orgSettings.createMany({
    data: { organizationId, ...buildDkSettingsDefaults() },
    skipDuplicates: true,
  })
}
