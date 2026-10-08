-- Invoices and quotes are numbered when they are issued, not when the draft is created, so a
-- deleted or abandoned draft never leaves a gap in the series. Draft rows may now have no
-- number. Existing rows keep the number they have: nothing is renumbered.
-- The unique index on (organizationId, number) is unchanged; PostgreSQL treats NULLs as distinct.
--
-- Rolling back: code from before this change requires every invoice and quote to have a number,
-- so do not simply restore NOT NULL. In this order, with the app stopped:
--   1. node scripts/prepare-number-rollback.mjs --confirm <database name>
--      It gives every numberless draft the next number of its organization and then restores
--      NOT NULL on both columns.
--   2. Deploy the previous release.
-- Deploying the previous release first would leave it drafts without a number, which it cannot handle.
-- See docs/number-at-issuance-rollback.md.
ALTER TABLE "invoice" ALTER COLUMN "number" DROP NOT NULL;
ALTER TABLE "quote" ALTER COLUMN "number" DROP NOT NULL;
