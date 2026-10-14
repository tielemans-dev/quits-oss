-- Existing organizations keep their settings. V2 supplies every Danish default explicitly.
ALTER TABLE "org_settings"
  ADD COLUMN "momsRegistered" BOOLEAN,
  ADD COLUMN "paymentTermsDays" INTEGER,
  ADD COLUMN "onboardingV2Key" TEXT,
  ADD COLUMN "onboardingV2Result" JSONB;
