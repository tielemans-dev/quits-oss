ALTER TABLE "deliverable"
  ADD COLUMN "deliveryRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "acceptedRevision" INTEGER,
  ADD COLUMN "acceptedVia" TEXT,
  ADD COLUMN "acceptanceEvidenceNote" TEXT,
  ADD COLUMN "changeRequestNote" TEXT;
