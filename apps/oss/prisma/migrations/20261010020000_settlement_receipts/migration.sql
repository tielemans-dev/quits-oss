-- AlterTable
ALTER TABLE "payment" ADD COLUMN     "allocationEvidence" TEXT,
ADD COLUMN     "allocationReason" TEXT,
ADD COLUMN     "exchangeEvidence" TEXT,
ADD COLUMN     "exchangeReason" TEXT,
ADD COLUMN     "receiptAmount" DECIMAL(12,2),
ADD COLUMN     "receiptId" TEXT;

-- CreateTable
CREATE TABLE "settlement_receipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "grossAmount" DECIMAL(12,2) NOT NULL,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "feeAmount" DECIMAL(12,2) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "feeReason" TEXT,
    "feeEvidence" TEXT,
    "actorKey" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "creditReason" TEXT,
    "creditEvidence" TEXT,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_refund" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlement_receipt_organizationId_contactId_idx" ON "settlement_receipt"("organizationId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_receipt_organizationId_reference_key" ON "settlement_receipt"("organizationId", "reference");

-- CreateIndex
CREATE INDEX "settlement_refund_receiptId_idx" ON "settlement_refund"("receiptId");

-- CreateIndex
CREATE INDEX "payment_receiptId_idx" ON "payment"("receiptId");

-- AddForeignKey
ALTER TABLE "settlement_receipt" ADD CONSTRAINT "settlement_receipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_receipt" ADD CONSTRAINT "settlement_receipt_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_refund" ADD CONSTRAINT "settlement_refund_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "settlement_receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "settlement_receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Validate every stored receipt independently of application code.
ALTER TABLE "settlement_receipt" ADD CONSTRAINT "settlement_receipt_amounts_check"
  CHECK ("grossAmount" > 0 AND "netAmount" >= 0 AND "feeAmount" >= 0 AND "grossAmount" = "netAmount" + "feeAmount"
    AND ("feeAmount" = 0 OR ("feeReason" IS NOT NULL AND "feeEvidence" IS NOT NULL)));
ALTER TABLE "settlement_refund" ADD CONSTRAINT "settlement_refund_positive_check" CHECK ("amount" > 0);
ALTER TABLE "payment" ADD CONSTRAINT "payment_receipt_amount_check"
  CHECK (("receiptId" IS NULL AND "receiptAmount" IS NULL) OR ("receiptId" IS NOT NULL AND "receiptAmount" IS NOT NULL AND "receiptAmount" > 0 AND "allocationReason" IS NOT NULL AND "allocationEvidence" IS NOT NULL));
