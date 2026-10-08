-- Generalise the OpenRouter-only AI settings into a provider choice.
-- Existing keys and models are kept: the columns are renamed, not copied, and every
-- existing organisation keeps using OpenRouter through the default provider value.
ALTER TABLE "org_settings" RENAME COLUMN "aiOpenRouterApiKeyEnc" TO "aiApiKeyEnc";
ALTER TABLE "org_settings" RENAME COLUMN "aiOpenRouterModel" TO "aiModel";
ALTER TABLE "org_settings" ADD COLUMN "aiProvider" TEXT NOT NULL DEFAULT 'openrouter',
ADD COLUMN "aiBaseUrl" TEXT;
