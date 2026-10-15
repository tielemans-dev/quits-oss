CREATE TABLE "vat_period_entry" (
    "organizationId" TEXT NOT NULL,
    "from" VARCHAR(10) NOT NULL,
    "to" VARCHAR(10) NOT NULL,
    "inputVat" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,
    CONSTRAINT "vat_period_entry_pkey" PRIMARY KEY ("organizationId", "from", "to"),
    CONSTRAINT "vat_period_entry_inputVat_nonnegative" CHECK ("inputVat" >= 0),
    CONSTRAINT "vat_period_entry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
