-- Archived ownership is separate from the live string namespace. PostgreSQL's existing
-- unique (organizationId, requestKey) index permits multiple NULL archive rows.
ALTER TABLE "artifact_staging" ALTER COLUMN "requestKey" DROP NOT NULL;
ALTER TABLE "artifact_staging" ADD COLUMN "archivedRequestKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Convert the exact legacy supersession marker, including aliases and embedded suffixes.
-- Do not infer supersession from ordinary abandonment, expiration or allocated numbers.
-- Only the final marker containing this row's own ID is removed.
UPDATE "artifact_staging" AS staging
SET "archivedRequestKeys" = ARRAY[left("requestKey", length("requestKey") - length('#superseded:' || id))]
    || ARRAY(SELECT CASE WHEN right(key, length('#superseded:' || staging.id)) = '#superseded:' || staging.id
                         THEN left(key, length(key) - length('#superseded:' || staging.id)) ELSE key END
             FROM unnest(staging."requestKeys") AS key),
    "requestKey" = NULL, "requestKeys" = ARRAY[]::TEXT[]
WHERE status = 'abandoned' AND NOT "numberWasAllocated" AND "documentKind" IN ('invoice', 'agreement')
  AND right("requestKey", length('#superseded:' || id)) = '#superseded:' || id;

-- This changes storage used by issuance. Stop old application writers before migrating,
-- then generate/deploy the matching client and application. Do not roll back to a client
-- that requires a non-NULL primary key while retained archives exist. The artifact sweep
-- retains staging rows and archived ownership; recovery ends at the original lease.
-- This migration never rewrites command receipts.
