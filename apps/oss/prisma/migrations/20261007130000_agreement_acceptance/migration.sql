ALTER TABLE "agreement"
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "acceptedOfferRevision" INTEGER,
  ADD COLUMN "acceptedByName" TEXT,
  ADD COLUMN "acceptanceIp" TEXT,
  ADD COLUMN "acceptanceUserAgent" TEXT,
  ADD COLUMN "acceptanceMethod" TEXT,
  ADD COLUMN "acceptanceEvidenceNote" TEXT,
  ADD COLUMN "declinedAt" TIMESTAMP(3),
  ADD COLUMN "declineReason" TEXT,
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "closeReason" TEXT;
CREATE TABLE "public_link_attempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "documentKind" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "targetId" TEXT,
  "revision" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "public_link_attempt_identity_createdAt_idx" ON "public_link_attempt"
  ("documentKind", "documentId", "scope", "keyVersion", "targetId", "revision", "createdAt");
CREATE INDEX "public_link_attempt_createdAt_idx" ON "public_link_attempt" ("createdAt");
