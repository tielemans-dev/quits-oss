-- Prisma's PostgreSQL migrations are not implicitly wrapped in a transaction, but a file with
-- several statements runs as one implicit transaction, which CONCURRENTLY rejects. Keep one
-- statement per migration and keep it outside BEGIN/COMMIT.
-- If interrupted, drop any INVALID index before marking the failed migration rolled
-- back and retrying. Do not use IF NOT EXISTS, which would accept an invalid index.

-- Serves organization invoice lists and the dashboard's recent invoices, ordered by
-- createdAt then id, and the agent invoice list's createdAt/id cursor. CONCURRENTLY lets
-- invoice writes continue while it builds.
CREATE INDEX CONCURRENTLY "invoice_organizationId_createdAt_id_idx" ON "invoice"("organizationId", "createdAt", "id");
