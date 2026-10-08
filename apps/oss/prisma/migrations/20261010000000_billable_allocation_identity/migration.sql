-- A billable source (today only an agreement deliverable) has at most one active allocation. Each
-- invoice line records the source it bills and the allocation generation it belongs to. The
-- generation advances only through an explicit, recorded rebill decision.
ALTER TABLE "deliverable" ADD COLUMN "billingGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "invoice_item"
  ADD COLUMN "sourceKind" TEXT,
  ADD COLUMN "sourceId" TEXT,
  ADD COLUMN "sourceRevision" TEXT,
  ADD COLUMN "allocationGeneration" INTEGER NOT NULL DEFAULT 0;

-- Legacy lines have no immutable record of the delivery revision billed. The deliverable may
-- have been redelivered since invoicing, so leave sourceRevision NULL rather than guess.
UPDATE "invoice_item" AS item
SET "sourceKind" = 'deliverable', "sourceId" = item."deliverableId"
FROM "deliverable" AS line
WHERE item."deliverableId" = line."id";

DROP INDEX "invoice_item_deliverableId_key";
CREATE UNIQUE INDEX "invoice_item_deliverableId_allocationGeneration_key" ON "invoice_item"("deliverableId", "allocationGeneration");
CREATE UNIQUE INDEX "invoice_item_sourceKind_sourceId_allocationGeneration_key" ON "invoice_item"("sourceKind", "sourceId", "allocationGeneration");

CREATE TABLE "deliverable_rebill" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "deliverableId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "priorInvoiceId" TEXT NOT NULL,
    "priorInvoiceItemId" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "deliverable_rebill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "deliverable_rebill_deliverableId_generation_key" ON "deliverable_rebill"("deliverableId", "generation");
CREATE INDEX "deliverable_rebill_agreementId_idx" ON "deliverable_rebill"("agreementId");
ALTER TABLE "deliverable_rebill" ADD CONSTRAINT "deliverable_rebill_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "agreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deliverable_rebill" ADD CONSTRAINT "deliverable_rebill_deliverableId_fkey" FOREIGN KEY ("deliverableId") REFERENCES "deliverable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deliverable_rebill" ADD CONSTRAINT "deliverable_rebill_priorInvoiceId_fkey" FOREIGN KEY ("priorInvoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deliverable_rebill" ADD CONSTRAINT "deliverable_rebill_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "credit_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
