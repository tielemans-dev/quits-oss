CREATE TABLE "EconomicConnection" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL UNIQUE REFERENCES "organization"("id") ON DELETE RESTRICT,
 "accountId" TEXT NOT NULL, "accountVerified" BOOLEAN NOT NULL DEFAULT false, "generation" INTEGER NOT NULL DEFAULT 1 CHECK ("generation" > 0),
 "state" TEXT NOT NULL DEFAULT 'connecting' CHECK ("state" IN ('connecting','connected','completed','failed','revoked','disconnected')),
 "encryptedCredentials" TEXT, "preflight" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CHECK ("state" NOT IN ('connected','completed') OR "accountVerified"),
 CHECK ("state" IN ('connecting','connected') OR "encryptedCredentials" IS NULL)
);
CREATE UNIQUE INDEX "EconomicConnection_id_organizationId_accountId_key" ON "EconomicConnection"("id","organizationId","accountId");
CREATE TABLE "EconomicReadOperation" (
 "id" TEXT PRIMARY KEY, "connectionId" TEXT NOT NULL REFERENCES "EconomicConnection"("id") ON DELETE RESTRICT,
 "generation" INTEGER NOT NULL, "requestKey" TEXT NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending','needs_review','failed','interrupted')),
 "failureCode" TEXT, "failureContext" JSONB, "manifest" JSONB, "manifestHash" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "EconomicReadOperation_connectionId_generation_requestKey_key" ON "EconomicReadOperation"("connectionId","generation","requestKey");
CREATE TABLE "EconomicSourceEvidence" (
 "id" TEXT PRIMARY KEY, "connectionId" TEXT NOT NULL,
 "organizationId" TEXT NOT NULL, "provider" TEXT NOT NULL DEFAULT 'economic' CHECK ("provider" = 'economic'),
 "accountId" TEXT NOT NULL, "kind" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "sourceHash" TEXT NOT NULL,
 "origin" TEXT NOT NULL DEFAULT 'historical_import' CHECK ("origin" = 'historical_import'),
 "intent" TEXT NOT NULL DEFAULT 'dry_run_only' CHECK ("intent" = 'dry_run_only'),
 "apiVersions" JSONB NOT NULL, "data" JSONB NOT NULL, "artifactState" TEXT, "artifactHash" TEXT, "artifactBytes" BYTEA,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("connectionId","organizationId","accountId") REFERENCES "EconomicConnection"("id","organizationId","accountId") ON DELETE RESTRICT,
 CHECK ("kind" IN ('customer','invoice','entry','pair','attachment','year')),
 CHECK (("artifactState" IS NULL AND "artifactHash" IS NULL AND "artifactBytes" IS NULL) OR
 ("artifactState" IS NOT NULL AND "artifactState" = 'missing' AND "artifactHash" IS NULL AND "artifactBytes" IS NULL) OR
 ("artifactState" IS NOT NULL AND "artifactState" = 'retrieved' AND "artifactHash" IS NOT NULL AND "artifactBytes" IS NOT NULL))
);
CREATE UNIQUE INDEX "EconomicSourceEvidence_organizationId_provider_accountId_kind_sourceId_key" ON "EconomicSourceEvidence"("organizationId","provider","accountId","kind","sourceId");
-- Staging identities and originals cannot be relabelled as new Quits revenue or silently revised.
CREATE FUNCTION economic_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Economic source evidence is immutable'; END;
$$;
CREATE TRIGGER economic_evidence_no_update BEFORE UPDATE ON "EconomicSourceEvidence" FOR EACH ROW EXECUTE FUNCTION economic_evidence_immutable();

-- Only a never-verified attempt can correct its expected agreement. Verification is permanent.
CREATE FUNCTION economic_account_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."accountVerified" AND (NOT NEW."accountVerified" OR NEW."accountId" <> OLD."accountId") THEN
   RAISE EXCEPTION 'Verified economic account binding is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER economic_account_no_rebind BEFORE UPDATE ON "EconomicConnection" FOR EACH ROW EXECUTE FUNCTION economic_account_binding_immutable();
