-- Bound dashboard cash aggregates by organization and payment-date window.
CREATE INDEX "settlement_receipt_organizationId_paidAt_idx" ON "settlement_receipt"("organizationId", "paidAt");
