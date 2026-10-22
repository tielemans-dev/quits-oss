-- A customer from a CVR lookup keeps the register's identity and registered address beside its
-- editable billing address. Existing customers keep their address as the billing address and stay
-- manual until someone updates them from CVR, since nothing recorded whether a lookup filled them.
ALTER TABLE "contact" ADD COLUMN "registrySource" TEXT,
ADD COLUMN "registryCheckedAt" TIMESTAMP(3),
ADD COLUMN "legalName" TEXT,
ADD COLUMN "registeredAddress" TEXT,
ADD COLUMN "registeredZip" TEXT,
ADD COLUMN "registeredCity" TEXT;
