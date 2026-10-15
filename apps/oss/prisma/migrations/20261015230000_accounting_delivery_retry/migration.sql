ALTER TABLE "event_consumer_delivery"
ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01 00:00:00',
ADD COLUMN "prepared" JSONB;
