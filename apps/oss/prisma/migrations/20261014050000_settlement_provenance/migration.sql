-- CreateTable
CREATE TABLE "settlement_evidence_source" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "accountReference" TEXT NOT NULL,
    "transactionReference" TEXT NOT NULL,
    "receiptId" TEXT,
    "createdReceiptId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "settlement_evidence_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_evidence" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "eventReference" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "feeAmount" DECIMAL(12,2) NOT NULL,
    "feeReason" TEXT,
    "feeEvidence" TEXT,
    "reason" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "correctsEvidenceId" TEXT,
    "reversesEvidenceId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_evidence_decision" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "identity" JSONB,
    "reason" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_evidence_decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlement_evidence_source_organizationId_contactId_idx" ON "settlement_evidence_source"("organizationId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_evidence_source_identity_key" ON "settlement_evidence_source"("organizationId", "source", "accountReference", "transactionReference");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_evidence_correctsEvidenceId_key" ON "settlement_evidence"("correctsEvidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_evidence_sourceId_eventReference_key" ON "settlement_evidence"("sourceId", "eventReference");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_evidence_sourceId_revision_key" ON "settlement_evidence"("sourceId", "revision");

-- CreateIndex
CREATE INDEX "settlement_evidence_decision_receiptId_idx" ON "settlement_evidence_decision"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_evidence_decision_sourceId_revision_key" ON "settlement_evidence_decision"("sourceId", "revision");

-- AddForeignKey
ALTER TABLE "settlement_evidence_source" ADD CONSTRAINT "settlement_evidence_source_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_evidence_source" ADD CONSTRAINT "settlement_evidence_source_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_evidence_source" ADD CONSTRAINT "settlement_evidence_source_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "settlement_receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_evidence_source" ADD CONSTRAINT "settlement_evidence_source_createdReceiptId_fkey" FOREIGN KEY ("createdReceiptId") REFERENCES "settlement_receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_evidence" ADD CONSTRAINT "settlement_evidence_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "settlement_evidence_source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_evidence_decision" ADD CONSTRAINT "settlement_evidence_decision_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "settlement_evidence_source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_evidence_decision" ADD CONSTRAINT "settlement_evidence_decision_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "settlement_evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_evidence_decision" ADD CONSTRAINT "settlement_evidence_decision_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "settlement_receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Observations and decisions are append-only. Corrections always insert a linked observation.
CREATE FUNCTION settlement_provenance_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Settlement provenance is immutable; append a correction';
END;
$$;
CREATE TRIGGER settlement_evidence_immutable BEFORE UPDATE ON settlement_evidence
  FOR EACH ROW EXECUTE FUNCTION settlement_provenance_no_update();
CREATE TRIGGER settlement_evidence_decision_immutable BEFORE UPDATE ON settlement_evidence_decision
  FOR EACH ROW EXECUTE FUNCTION settlement_provenance_no_update();
ALTER TABLE settlement_evidence ADD CONSTRAINT settlement_evidence_amounts_check
  CHECK ("netAmount" >= 0 AND "feeAmount" >= 0 AND "netAmount" + "feeAmount" > 0
    AND ("feeAmount" = 0 OR ("feeReason" IS NOT NULL AND "feeEvidence" IS NOT NULL)));
