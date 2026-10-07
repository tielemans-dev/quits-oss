-- Replace destructive financial cascades atomically. No records are removed.
BEGIN;

-- DropForeignKey
ALTER TABLE "org_settings" DROP CONSTRAINT "org_settings_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "contact" DROP CONSTRAINT "contact_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "organization_tax_id" DROP CONSTRAINT "organization_tax_id_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "invoice" DROP CONSTRAINT "invoice_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "invoice_item" DROP CONSTRAINT "invoice_item_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "quote" DROP CONSTRAINT "quote_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "quote_item" DROP CONSTRAINT "quote_item_quoteId_fkey";

-- DropForeignKey
ALTER TABLE "credit_note" DROP CONSTRAINT "credit_note_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "credit_note_item" DROP CONSTRAINT "credit_note_item_creditNoteId_fkey";

-- DropForeignKey
ALTER TABLE "payment" DROP CONSTRAINT "payment_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "invoice_reminder" DROP CONSTRAINT "invoice_reminder_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "recurring_invoice" DROP CONSTRAINT "recurring_invoice_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "domain_event" DROP CONSTRAINT "domain_event_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "approval_request" DROP CONSTRAINT "approval_request_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "approval_request" DROP CONSTRAINT "approval_request_agentKeyId_fkey";

-- DropForeignKey
ALTER TABLE "agent_key" DROP CONSTRAINT "agent_key_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "agreement" DROP CONSTRAINT "agreement_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "deliverable" DROP CONSTRAINT "deliverable_agreementId_fkey";

-- DropForeignKey
ALTER TABLE "agreement_template" DROP CONSTRAINT "agreement_template_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "artifact_staging" DROP CONSTRAINT "artifact_staging_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "issuance_candidate" DROP CONSTRAINT "issuance_candidate_organizationId_fkey";

-- AddForeignKey
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_tax_id" ADD CONSTRAINT "organization_tax_id_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_item" ADD CONSTRAINT "invoice_item_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_item" ADD CONSTRAINT "quote_item_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_item" ADD CONSTRAINT "credit_note_item_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "credit_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_reminder" ADD CONSTRAINT "invoice_reminder_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoice" ADD CONSTRAINT "recurring_invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_event" ADD CONSTRAINT "domain_event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_agentKeyId_fkey" FOREIGN KEY ("agentKeyId") REFERENCES "agent_key"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_key" ADD CONSTRAINT "agent_key_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement" ADD CONSTRAINT "agreement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverable" ADD CONSTRAINT "deliverable_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "agreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_template" ADD CONSTRAINT "agreement_template_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_staging" ADD CONSTRAINT "artifact_staging_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issuance_candidate" ADD CONSTRAINT "issuance_candidate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


COMMIT;
