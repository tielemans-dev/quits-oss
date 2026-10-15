-- Defaults apply only to future inserts. Keep every saved organization's settings intact.
ALTER TABLE "org_settings"
  ALTER COLUMN "countryCode" SET DEFAULT 'DK',
  ALTER COLUMN "locale" SET DEFAULT 'da-DK',
  ALTER COLUMN "timezone" SET DEFAULT 'Europe/Copenhagen',
  ALTER COLUMN "defaultCurrency" SET DEFAULT 'DKK',
  ALTER COLUMN "baseCurrency" SET DEFAULT 'DKK',
  ALTER COLUMN "taxRegime" SET DEFAULT 'eu_vat',
  ALTER COLUMN "currency" SET DEFAULT 'DKK',
  ALTER COLUMN "taxRate" SET DEFAULT 25;
