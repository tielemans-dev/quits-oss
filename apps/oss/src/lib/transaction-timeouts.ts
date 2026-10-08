import type { Prisma } from "../../generated/prisma/client"

/** Bound advisory admission without shortening later organization/document lock waits. */
export async function acquireBoundedAdvisoryLock(tx: Prisma.TransactionClient, key: string) {
  const [previous] = await tx.$queryRaw<Array<{ lockTimeout: string }>>`
    SELECT current_setting('lock_timeout') AS "lockTimeout"`
  // Transaction-local settings also work with transaction pooling. The 3s admission bound
  // precedes Prisma's default 5s transaction limit in the public-link path.
  await tx.$executeRaw`SELECT
    set_config('lock_timeout', '3s', true),
    set_config('statement_timeout', '30s', true),
    set_config('idle_in_transaction_session_timeout', '60s', true)`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
  // Preserve role-level bounds, including a stricter configured value, for all later row locks.
  // On failure the caller rolls back the transaction, which restores every local setting.
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${previous.lockTimeout}, true)`
}
