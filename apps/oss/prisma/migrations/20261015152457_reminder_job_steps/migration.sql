-- CreateEnum
CREATE TYPE "JobStepStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed');

-- AlterTable
ALTER TABLE "job" ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "job_step" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "invoiceId" TEXT,
    "status" "JobStepStatus" NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveryKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_step_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_step_jobId_position_key" ON "job_step"("jobId", "position");

-- CreateIndex
CREATE INDEX "job_organizationId_type_createdAt_idx" ON "job"("organizationId", "type", "createdAt");

-- AddForeignKey
ALTER TABLE "job_step" ADD CONSTRAINT "job_step_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
