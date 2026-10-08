-- Prisma's PostgreSQL migrations are not implicitly wrapped in a transaction, but a file with
-- several statements runs as one implicit transaction, which CONCURRENTLY rejects. Keep one
-- statement per migration and keep it outside BEGIN/COMMIT.
-- If interrupted, drop any INVALID index before marking the failed migration rolled
-- back and retrying. Do not use IF NOT EXISTS, which would accept an invalid index.

-- The issued-document check filters domain events by organization and a short list of
-- issuance types. The existing (organizationId, aggregateType, aggregateId) index narrows to
-- the organization only, so without this index the check reads every event row of an
-- organization that has none of those types. That is small for most organizations; this
-- index bounds the check for organizations with long event histories.
CREATE INDEX CONCURRENTLY "domain_event_organizationId_type_idx" ON "domain_event"("organizationId", "type");
