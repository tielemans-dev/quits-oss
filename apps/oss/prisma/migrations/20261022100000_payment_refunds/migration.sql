-- CreateTable
CREATE TABLE "payment_refund" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "refundedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "actorKey" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_refund_invoiceId_idx" ON "payment_refund"("invoiceId");

-- CreateIndex
CREATE INDEX "payment_refund_organizationId_refundedAt_idx" ON "payment_refund"("organizationId", "refundedAt");

-- AddForeignKey
ALTER TABLE "payment_refund" ADD CONSTRAINT "payment_refund_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refund" ADD CONSTRAINT "payment_refund_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Refunds are positive outflows; a correction voids the refund instead of recording a negative one.
ALTER TABLE "payment_refund" ADD CONSTRAINT "payment_refund_positive_check" CHECK ("amount" > 0);
