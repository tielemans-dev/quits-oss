-- Calendar dates are stored as UTC midnight in timestamp-without-time-zone columns.
-- Older deliverable defaults and datetime API inputs could instead store instants.
-- Recover the calendar day the old formatter displayed using each document's own
-- frozen timezone, never the organisation's current settings or the DB session zone.
-- Joining pg_timezone_names skips missing/unknown timezone values without guessing.
-- UTC-midnight rows are already calendar dates and must not be shifted west again.
-- Only live columns change: snapshots, events, artifacts and updatedAt stay intact.
UPDATE "invoice" AS document
SET "dueDate" = date_trunc('day', document."dueDate" AT TIME ZONE 'UTC' AT TIME ZONE zone.name)
FROM pg_timezone_names AS zone
WHERE lower(btrim(document."timezone")) = lower(zone.name)
  AND document."dueDate" <> date_trunc('day', document."dueDate");

UPDATE "quote" AS document
SET "expiryDate" = date_trunc('day', document."expiryDate" AT TIME ZONE 'UTC' AT TIME ZONE zone.name)
FROM pg_timezone_names AS zone
WHERE lower(btrim(document."timezone")) = lower(zone.name)
  AND document."expiryDate" <> date_trunc('day', document."expiryDate");
