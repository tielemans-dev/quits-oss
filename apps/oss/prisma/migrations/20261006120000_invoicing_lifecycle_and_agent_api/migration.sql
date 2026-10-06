-- AlterTable
ALTER TABLE "contact" ADD COLUMN     "peppolEndpointId" TEXT,
ADD COLUMN     "peppolEndpointScheme" TEXT;

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "amountCredited" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "amountPaid" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "recurringInvoiceId" TEXT,
ADD COLUMN     "recurringRunDate" TIMESTAMP(3),
ADD COLUMN     "remindersPaused" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "creditNoteNextNum" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "creditNotePrefix" TEXT NOT NULL DEFAULT 'CN',
ADD COLUMN     "eventSequence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reminderPolicy" JSONB;

-- CreateTable
CREATE TABLE "credit_note" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "reason" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotalNet" DECIMAL(12,2) NOT NULL,
    "totalTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalGross" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "taxRegime" TEXT NOT NULL,
    "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT false,
    "sellerSnapshot" JSONB,
    "buyerSnapshot" JSONB,
    "notes" TEXT,
    "lastEmailAttemptAt" TIMESTAMP(3),
    "lastEmailAttemptOutcome" TEXT,
    "lastEmailAttemptCode" TEXT,
    "lastEmailAttemptMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_item" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "invoiceItemId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unitPriceNet" DECIMAL(12,2) NOT NULL,
    "unitPriceGross" DECIMAL(12,2) NOT NULL,
    "lineNet" DECIMAL(12,2) NOT NULL,
    "lineTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lineGross" DECIMAL(12,2) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "taxCategory" TEXT NOT NULL DEFAULT 'standard',
    "taxCode" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "credit_note_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "source" TEXT NOT NULL,
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_reminder" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "outcome" TEXT,
    "outcomeMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_invoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "intervalCount" INTEGER NOT NULL DEFAULT 1,
    "intervalUnit" TEXT NOT NULL DEFAULT 'month',
    "startDate" TIMESTAMP(3) NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "remainingRuns" INTEGER,
    "dueInDays" INTEGER NOT NULL DEFAULT 14,
    "autoSend" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "notes" TEXT,
    "items" JSONB NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_event" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "approvedByUserId" TEXT,
    "commandId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "command_receipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "command_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_request" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "agentKeyId" TEXT NOT NULL,
    "commandReceiptId" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "command" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_key" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'approval_required',
    "scopes" TEXT[],
    "secretHash" TEXT NOT NULL,
    "displayPrefix" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_note_organizationId_idx" ON "credit_note"("organizationId");

-- CreateIndex
CREATE INDEX "credit_note_invoiceId_idx" ON "credit_note"("invoiceId");

-- CreateIndex
CREATE INDEX "credit_note_organizationId_issueDate_idx" ON "credit_note"("organizationId", "issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_organizationId_number_key" ON "credit_note"("organizationId", "number");

-- CreateIndex
CREATE INDEX "credit_note_item_creditNoteId_idx" ON "credit_note_item"("creditNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_stripeCheckoutSessionId_key" ON "payment"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "payment_organizationId_idx" ON "payment"("organizationId");

-- CreateIndex
CREATE INDEX "payment_invoiceId_idx" ON "payment"("invoiceId");

-- CreateIndex
CREATE INDEX "payment_organizationId_paidAt_idx" ON "payment"("organizationId", "paidAt");

-- CreateIndex
CREATE INDEX "invoice_reminder_sentAt_scheduledFor_idx" ON "invoice_reminder"("sentAt", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_reminder_invoiceId_offsetDays_key" ON "invoice_reminder"("invoiceId", "offsetDays");

-- CreateIndex
CREATE INDEX "recurring_invoice_organizationId_idx" ON "recurring_invoice"("organizationId");

-- CreateIndex
CREATE INDEX "recurring_invoice_status_nextRunAt_idx" ON "recurring_invoice"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "domain_event_organizationId_aggregateType_aggregateId_idx" ON "domain_event"("organizationId", "aggregateType", "aggregateId");

-- CreateIndex
CREATE UNIQUE INDEX "domain_event_organizationId_sequence_key" ON "domain_event"("organizationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "command_receipt_organizationId_actorKey_clientRequestId_key" ON "command_receipt"("organizationId", "actorKey", "clientRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "approval_request_commandReceiptId_key" ON "approval_request"("commandReceiptId");

-- CreateIndex
CREATE INDEX "approval_request_organizationId_status_idx" ON "approval_request"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_key_secretHash_key" ON "agent_key"("secretHash");

-- CreateIndex
CREATE INDEX "agent_key_organizationId_idx" ON "agent_key"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "job_dedupeKey_key" ON "job"("dedupeKey");

-- CreateIndex
CREATE INDEX "job_status_runAfter_idx" ON "job"("status", "runAfter");

-- CreateIndex
CREATE INDEX "invoice_organizationId_dueDate_idx" ON "invoice"("organizationId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_recurringInvoiceId_recurringRunDate_key" ON "invoice"("recurringInvoiceId", "recurringRunDate");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_recurringInvoiceId_fkey" FOREIGN KEY ("recurringInvoiceId") REFERENCES "recurring_invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_item" ADD CONSTRAINT "credit_note_item_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "credit_note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_reminder" ADD CONSTRAINT "invoice_reminder_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoice" ADD CONSTRAINT "recurring_invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoice" ADD CONSTRAINT "recurring_invoice_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_event" ADD CONSTRAINT "domain_event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_agentKeyId_fkey" FOREIGN KEY ("agentKeyId") REFERENCES "agent_key"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_key" ADD CONSTRAINT "agent_key_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "invoice_organization_id_payment_status_idx" RENAME TO "invoice_organizationId_paymentStatus_idx";


-- Backfill: invoices already marked paid get a payment record for their full total.
INSERT INTO "payment" ("id", "organizationId", "invoiceId", "amount", "currency", "paidAt", "method", "source", "stripeCheckoutSessionId", "stripePaymentIntentId", "createdAt", "updatedAt")
SELECT
  'pay_' || replace(gen_random_uuid()::text, '-', ''),
  i."organizationId",
  i."id",
  i."totalGross",
  i."currency",
  COALESCE(i."paidAt", i."updatedAt"),
  CASE WHEN i."stripeCheckoutSessionId" IS NOT NULL THEN 'stripe' ELSE 'other' END,
  'migration',
  i."stripeCheckoutSessionId",
  i."stripePaymentIntentId",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "invoice" i
WHERE i."paymentStatus" = 'paid' OR i."status" = 'paid';

UPDATE "invoice"
SET "amountPaid" = "totalGross", "paymentStatus" = 'paid'
WHERE "paymentStatus" = 'paid' OR "status" = 'paid';
