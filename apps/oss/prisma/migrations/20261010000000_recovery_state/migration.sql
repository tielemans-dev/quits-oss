-- CreateTable
CREATE TABLE "recovery_state" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "operationsMode" TEXT NOT NULL DEFAULT 'live',
    "heldReason" TEXT,
    "heldAt" TIMESTAMP(3),
    "restoredFrom" JSONB,
    "restoreReport" JSONB,
    "enabledAt" TIMESTAMP(3),
    "lastSchedulerTickAt" TIMESTAMP(3),
    "lastSchedulerTickOk" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_record" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "manifestSha256" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backup_record_kind_createdAt_idx" ON "backup_record"("kind", "createdAt");
