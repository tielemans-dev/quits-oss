-- CreateEnum
CREATE TYPE "CvrVerificationStatus" AS ENUM ('pending', 'verified', 'invalid', 'inactive');

-- CreateTable
CREATE TABLE "organization_cvr_verification" (
    "organizationId" TEXT NOT NULL,
    "cvr" TEXT NOT NULL,
    "status" "CvrVerificationStatus" NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,

    CONSTRAINT "organization_cvr_verification_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE INDEX "organization_cvr_verification_status_nextAttemptAt_idx" ON "organization_cvr_verification"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "organization_cvr_verification" ADD CONSTRAINT "organization_cvr_verification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
