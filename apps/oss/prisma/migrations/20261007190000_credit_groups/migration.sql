ALTER TABLE "credit_note" ADD COLUMN "creditedGroups" JSONB,
ADD COLUMN "payableRounding" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "credit_note_item" ADD COLUMN "vatRateInput" TEXT;
