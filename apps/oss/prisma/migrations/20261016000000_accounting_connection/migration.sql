CREATE TYPE "AccountingProviderId" AS ENUM ('economic', 'dinero');
CREATE TYPE "AccountingConnectionStatus" AS ENUM ('connected', 'disconnected');
CREATE TABLE "accounting_connection" (
    "organizationId" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "provider" "AccountingProviderId" NOT NULL,
    "status" "AccountingConnectionStatus" NOT NULL DEFAULT 'disconnected',
    "remoteAccountId" TEXT NOT NULL,
    "credentialEnc" TEXT,
    "mappingRevision" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "accounting_connection_pkey" PRIMARY KEY ("organizationId"),
    CONSTRAINT "accounting_connection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "accounting_connection_connected_credential" CHECK ("status" <> 'connected' OR "credentialEnc" IS NOT NULL)
);
CREATE INDEX "accounting_connection_status_provider_idx" ON "accounting_connection"("status", "provider");
