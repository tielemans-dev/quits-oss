CREATE TYPE "InvoicePurpose" AS ENUM ('sale', 'prepayment');
ALTER TABLE "invoice" ADD COLUMN "purpose" "InvoicePurpose" NOT NULL DEFAULT 'sale',
  ADD COLUMN "scheduleSaleChoice" JSONB, ADD COLUMN "agreementId" TEXT;
ALTER TABLE "agreement" ADD COLUMN "offerFormatVersion" INTEGER, ADD COLUMN "taxRateInput" TEXT;
ALTER TABLE "deliverable" ADD COLUMN "vatRateInput" TEXT;
ALTER TABLE "invoice_item" ADD COLUMN "deliverableId" TEXT;
CREATE UNIQUE INDEX "invoice_item_deliverableId_key" ON "invoice_item"("deliverableId");
CREATE INDEX "invoice_agreementId_idx" ON "invoice"("agreementId");
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "agreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_item" ADD CONSTRAINT "invoice_item_deliverableId_fkey" FOREIGN KEY ("deliverableId") REFERENCES "deliverable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
