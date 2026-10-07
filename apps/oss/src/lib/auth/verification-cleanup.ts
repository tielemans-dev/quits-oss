import type { PrismaClient } from "../../../generated/prisma/client"

/** Run on the root client before auth transactions acquire user or verification locks. */
export async function cleanupExpiredVerifications(prisma: PrismaClient) {
  // Native verification readers delete every expired record. A callback can then hold a sibling
  // while waiting for a reset's token, as that reset waits to invalidate the sibling. Lock only
  // a bounded set of available rows and delete them in this single, standalone statement.
  // Prisma DateTime columns store UTC without a timezone; match that type regardless of the
  // connection's timezone instead of letting PostgreSQL interpret expiry as local time.
  return prisma.$executeRaw`
    WITH expired AS (
      SELECT id FROM verification
      WHERE "expiresAt" < (NOW() AT TIME ZONE 'UTC')
      ORDER BY "expiresAt", id
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM verification USING expired
    WHERE verification.id = expired.id AND verification."expiresAt" < (NOW() AT TIME ZONE 'UTC')
  `
}
