ALTER TABLE "agreement" ADD COLUMN "sourceQuoteId" TEXT;
CREATE UNIQUE INDEX "agreement_sourceQuoteId_key" ON "agreement"("sourceQuoteId");
ALTER TABLE "agreement" ADD CONSTRAINT "agreement_sourceQuoteId_fkey" FOREIGN KEY ("sourceQuoteId") REFERENCES "quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization" ADD COLUMN "agreementTemplatesSeeded" BOOLEAN NOT NULL DEFAULT false;
UPDATE "organization" SET "agreementTemplatesSeeded" = true WHERE EXISTS (SELECT 1 FROM "agreement_template" WHERE "organizationId" = "organization"."id");
