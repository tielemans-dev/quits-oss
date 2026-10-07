-- Prisma's PostgreSQL migrations are not implicitly wrapped in a transaction.
-- Keep this migration outside BEGIN/COMMIT: CONCURRENTLY permits verification writes
-- while building the index used by request-time bounded cleanup.
-- If interrupted, drop any INVALID index before marking the failed migration rolled
-- back and retrying. Do not use IF NOT EXISTS, which would accept an invalid index.
CREATE INDEX CONCURRENTLY "verification_expiresAt_id_idx" ON "verification"("expiresAt", "id");
