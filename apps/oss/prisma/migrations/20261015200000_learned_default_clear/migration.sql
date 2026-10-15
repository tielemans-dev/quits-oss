CREATE TABLE "learned_default_clear" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "clearedValue" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "learned_default_clear_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "learned_default_clear_contactId_field_key" ON "learned_default_clear"("contactId", "field");
CREATE INDEX "learned_default_clear_organizationId_idx" ON "learned_default_clear"("organizationId");
ALTER TABLE "learned_default_clear" ADD CONSTRAINT "learned_default_clear_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
