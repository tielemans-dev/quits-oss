-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "agreementNextNum" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "agreementPrefix" TEXT NOT NULL DEFAULT 'AGR';

-- CreateTable
CREATE TABLE "agreement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "termsMarkdown" TEXT NOT NULL,
    "templateId" TEXT,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "countryCode" TEXT NOT NULL DEFAULT 'US',
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "taxRegime" TEXT NOT NULL DEFAULT 'us_sales_tax',
    "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT false,
    "dueInDays" INTEGER NOT NULL DEFAULT 30,
    "billingTrigger" TEXT NOT NULL DEFAULT 'on_acceptance',
    "subtotalNet" DECIMAL(12,2) NOT NULL,
    "totalTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalGross" DECIMAL(12,2) NOT NULL,
    "sellerSnapshot" JSONB,
    "buyerSnapshot" JSONB,
    "validUntil" DATE NOT NULL,
    "issueDate" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "offerRevision" INTEGER NOT NULL DEFAULT 0,
    "offerSnapshot" JSONB,
    "offerSnapshotHash" TEXT,
    "issuedToEmail" TEXT,
    "issuedVia" TEXT,
    "publicAccessKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "publicAccessIssuedAt" TIMESTAMP(3),
    "lastEmailAttemptAt" TIMESTAMP(3),
    "lastEmailAttemptOutcome" TEXT,
    "lastEmailAttemptCode" TEXT,
    "lastEmailAttemptMessage" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliverable" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
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
    "agreedDate" DATE,
    "expectedDate" DATE,
    "isDeposit" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "billingStatus" TEXT NOT NULL DEFAULT 'unbilled',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "deliverable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agreement_template" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "termsMarkdown" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agreement_template_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agreement_organizationId_status_idx" ON "agreement"("organizationId", "status");

-- CreateIndex
CREATE INDEX "agreement_contactId_idx" ON "agreement"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "agreement_organizationId_number_key" ON "agreement"("organizationId", "number");

-- CreateIndex
CREATE INDEX "deliverable_agreementId_idx" ON "deliverable"("agreementId");

-- CreateIndex
CREATE UNIQUE INDEX "agreement_template_organizationId_name_key" ON "agreement_template"("organizationId", "name");

-- AddForeignKey
ALTER TABLE "agreement" ADD CONSTRAINT "agreement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement" ADD CONSTRAINT "agreement_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement" ADD CONSTRAINT "agreement_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "agreement_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverable" ADD CONSTRAINT "deliverable_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "agreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_template" ADD CONSTRAINT "agreement_template_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express this partial index. At most one default per organization.
CREATE UNIQUE INDEX "agreement_template_one_default" ON "agreement_template" ("organizationId") WHERE "isDefault";
