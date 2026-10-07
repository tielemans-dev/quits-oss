-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "artifactPdfHash" TEXT,
ADD COLUMN     "artifactPdfRef" TEXT,
ADD COLUMN     "artifactUblHash" TEXT,
ADD COLUMN     "artifactUblRef" TEXT;

-- AlterTable
ALTER TABLE "credit_note" ADD COLUMN     "artifactPdfHash" TEXT,
ADD COLUMN     "artifactPdfRef" TEXT,
ADD COLUMN     "artifactUblHash" TEXT,
ADD COLUMN     "artifactUblRef" TEXT;

-- AlterTable
ALTER TABLE "agreement" ADD COLUMN     "artifactPdfHash" TEXT,
ADD COLUMN     "artifactPdfRef" TEXT,
ADD COLUMN     "artifactUblHash" TEXT,
ADD COLUMN     "artifactUblRef" TEXT;

-- CreateTable
CREATE TABLE "artifact_staging" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentKind" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "renderInputHash" TEXT NOT NULL,
    "renderInput" JSONB NOT NULL,
    "rendererVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "prepToken" TEXT,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "artifacts" JSONB,
    "missingReason" TEXT,
    "reservedNumber" TEXT,
    "numberWasAllocated" BOOLEAN NOT NULL DEFAULT false,
    "candidateRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artifact_staging_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issuance_candidate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentKind" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "stagingId" TEXT NOT NULL,
    "renderInput" JSONB NOT NULL,
    "renderInputHash" TEXT NOT NULL,
    "recipient" TEXT,
    "artifacts" JSONB,
    "attemptAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'bound',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issuance_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "artifact_staging_organizationId_status_leaseUntil_idx" ON "artifact_staging"("organizationId", "status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_staging_organizationId_documentKind_documentId_ren_key" ON "artifact_staging"("organizationId", "documentKind", "documentId", "renderInputHash");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_staging_organizationId_requestKey_key" ON "artifact_staging"("organizationId", "requestKey");

-- CreateIndex
CREATE INDEX "issuance_candidate_organizationId_documentKind_documentId_idx" ON "issuance_candidate"("organizationId", "documentKind", "documentId");

-- CreateIndex
CREATE INDEX "issuance_candidate_stagingId_status_createdAt_idx" ON "issuance_candidate"("stagingId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "artifact_staging" ADD CONSTRAINT "artifact_staging_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issuance_candidate" ADD CONSTRAINT "issuance_candidate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issuance_candidate" ADD CONSTRAINT "issuance_candidate_stagingId_fkey" FOREIGN KEY ("stagingId") REFERENCES "artifact_staging"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

