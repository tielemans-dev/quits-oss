import type { Prisma } from "../../generated/prisma/client"

/** Server-enforced bounds survive a caller disappearing while waiting for an advisory lock. */
export async function boundLockTransaction(tx: Prisma.TransactionClient) {
  // Transaction-local settings also work with transaction pooling. One round trip, and no
  // session state leaks to the next borrower. The lock bound precedes Prisma's default 5s limit.
  await tx.$executeRaw`SELECT
    set_config('lock_timeout', '3s', true),
    set_config('statement_timeout', '30s', true),
    set_config('idle_in_transaction_session_timeout', '60s', true)`
}
