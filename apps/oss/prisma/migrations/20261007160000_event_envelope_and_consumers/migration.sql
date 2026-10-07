-- The non-null default also initializes all existing events to v1.
ALTER TABLE "domain_event" ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "domain_event" ADD CONSTRAINT "domain_event_schema_version_positive" CHECK ("schemaVersion" > 0);

CREATE TYPE "EventConsumerDeliveryStatus" AS ENUM ('pending', 'claimed', 'done', 'failed', 'skipped');
CREATE TABLE "event_consumer_cursor" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "consumerKey" TEXT NOT NULL,
  "acknowledgedSequence" INTEGER NOT NULL DEFAULT 0,
  "scannedSequence" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "event_consumer_cursor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_consumer_cursor_positions" CHECK (0 <= "acknowledgedSequence" AND "acknowledgedSequence" <= "scannedSequence" AND "version" >= 0)
);
CREATE TABLE "event_consumer_delivery" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "consumerKey" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "status" "EventConsumerDeliveryStatus" NOT NULL DEFAULT 'pending',
  "claimToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "externalRef" TEXT,
  "error" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "event_consumer_delivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "event_consumer_cursor_organizationId_consumerKey_key" ON "event_consumer_cursor"("organizationId", "consumerKey");
CREATE UNIQUE INDEX "event_consumer_delivery_organizationId_consumerKey_sequence_key" ON "event_consumer_delivery"("organizationId", "consumerKey", "sequence");
CREATE INDEX "event_consumer_delivery_scope_status_sequence_idx" ON "event_consumer_delivery"("organizationId", "consumerKey", "status", "sequence");
ALTER TABLE "event_consumer_cursor" ADD CONSTRAINT "event_consumer_cursor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_consumer_delivery" ADD CONSTRAINT "event_consumer_delivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
