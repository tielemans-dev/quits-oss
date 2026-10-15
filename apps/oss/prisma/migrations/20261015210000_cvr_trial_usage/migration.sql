-- Pre-check only: duplicates are valid on self-host. Resolve them before a hosted
-- runtime enables enforceCvrUniqueness. This migration does not change existing IDs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM organization_tax_id
    WHERE lower(trim(scheme)) IN ('cvr', 'dk_cvr', 'vat', 'dk_vat')
      AND ("countryCode" IS NULL OR upper(trim("countryCode")) IN ('', 'DK'))
    GROUP BY regexp_replace(regexp_replace(upper(value), '[[:space:]./\-]', '', 'g'), '^DK', '')
    HAVING count(DISTINCT "organizationId") > 1
  ) THEN
    RAISE NOTICE 'Duplicate Danish registration IDs exist; resolve before enabling hosted CVR admission.';
  END IF;
END $$;

-- No organization foreign key: deleting an organization must not restore eligibility.
CREATE TABLE "cvr_trial_usage" (
    "cvr" TEXT NOT NULL,
    "firstOrganizationId" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cvr_trial_usage_pkey" PRIMARY KEY ("cvr")
);
