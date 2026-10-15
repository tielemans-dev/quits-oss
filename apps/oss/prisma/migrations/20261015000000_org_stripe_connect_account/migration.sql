-- Cached Stripe Connect account for an organization. Nullable and unique so several
-- organizations can stay unlinked, while one Stripe account maps to at most one organization.
-- Existing rows start as `none` with no timestamp. Self-hosted installs keep using the BYOK
-- key columns; these columns stay empty until an account is linked.
CREATE TYPE "StripeAccountStatus" AS ENUM ('none', 'pending', 'active', 'restricted');

ALTER TABLE "org_settings"
  ADD COLUMN "stripeAccountId" TEXT,
  ADD COLUMN "stripeAccountStatus" "StripeAccountStatus" NOT NULL DEFAULT 'none',
  ADD COLUMN "stripeAccountStatusAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "org_settings_stripeAccountId_key" ON "org_settings"("stripeAccountId");
