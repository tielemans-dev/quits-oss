ALTER TABLE "accounting_connection" ADD COLUMN "syncStartAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "reviewBefore" TIMESTAMP(3);
-- Keep existing outbox work eligible, but require a decision for unscanned history.
UPDATE "accounting_connection" c SET "syncStartAt" = COALESCE((
  SELECT MIN(e."occurredAt") FROM "event_consumer_delivery" d
  JOIN "domain_event" e ON e."organizationId" = d."organizationId" AND e."sequence" = d."sequence"
  WHERE d."organizationId" = c."organizationId" AND d."consumerKey" LIKE 'accounting:%'
), CURRENT_TIMESTAMP), "reviewBefore" = CURRENT_TIMESTAMP;
