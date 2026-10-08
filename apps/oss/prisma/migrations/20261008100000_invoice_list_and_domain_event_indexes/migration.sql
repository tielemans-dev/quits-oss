-- Prisma's PostgreSQL migrations are not implicitly wrapped in a transaction.
-- Keep these statements outside BEGIN/COMMIT: CONCURRENTLY lets writes continue while the
-- indexes build on the invoice and domain_event tables.
-- If interrupted, drop any INVALID index before marking the failed migration rolled
-- back and retrying. Do not use IF NOT EXISTS, which would accept an invalid index.

-- Serves organization invoice lists and the dashboard's recent-invoice query, both ordered by createdAt.
CREATE INDEX CONCURRENTLY "invoice_organizationId_createdAt_idx" ON "invoice"("organizationId", "createdAt");

-- Serves the issued-document check that runs on every settings read.
CREATE INDEX CONCURRENTLY "domain_event_organizationId_type_idx" ON "domain_event"("organizationId", "type");
