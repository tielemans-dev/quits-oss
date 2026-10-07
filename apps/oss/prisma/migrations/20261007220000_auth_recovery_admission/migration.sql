CREATE TABLE "auth_recovery_rate_limit" (
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "resetAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "auth_recovery_rate_limit_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "auth_recovery_rate_limit_resetAt_idx" ON "auth_recovery_rate_limit"("resetAt");
