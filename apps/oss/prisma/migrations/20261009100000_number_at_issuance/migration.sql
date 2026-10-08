-- Invoices and quotes are numbered when they are issued, not when the draft is created, so a
-- deleted or abandoned draft never leaves a gap in the series. Draft rows may now have no
-- number. Existing rows keep the number they have: nothing is renumbered.
-- The unique index on (organizationId, number) is unchanged; PostgreSQL treats NULLs as distinct.
ALTER TABLE "invoice" ALTER COLUMN "number" DROP NOT NULL;
ALTER TABLE "quote" ALTER COLUMN "number" DROP NOT NULL;
