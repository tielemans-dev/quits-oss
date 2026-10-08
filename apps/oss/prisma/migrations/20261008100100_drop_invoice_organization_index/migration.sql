-- Prisma's PostgreSQL migrations are not implicitly wrapped in a transaction, but a file with
-- several statements runs as one implicit transaction, which CONCURRENTLY rejects. Keep one
-- statement per migration and keep it outside BEGIN/COMMIT.
-- If interrupted, drop any INVALID index before marking the failed migration rolled
-- back and retrying. Do not use IF NOT EXISTS, which would accept an invalid index.

-- invoice(organizationId, createdAt, id), created by the previous migration, leads with
-- organizationId, so it serves every lookup the single-column index did.
DROP INDEX CONCURRENTLY "invoice_organizationId_idx";
