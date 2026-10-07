-- Additive metadata only. Defaults keep every existing writer on legacy pricing.

ALTER TABLE "invoice" ADD COLUMN "calculationVersion" TEXT NOT NULL DEFAULT 'legacy_per_line',
  ADD COLUMN "vatEvidence" JSONB;

ALTER TABLE "quote" ADD COLUMN "calculationVersion" TEXT NOT NULL DEFAULT 'legacy_per_line',
  ADD COLUMN "vatEvidence" JSONB;

ALTER TABLE "credit_note" ADD COLUMN "calculationVersion" TEXT NOT NULL DEFAULT 'legacy_per_line',
  ADD COLUMN "vatEvidence" JSONB;

ALTER TABLE "agreement" ADD COLUMN "calculationVersion" TEXT NOT NULL DEFAULT 'legacy_per_line',
  ADD COLUMN "vatEvidence" JSONB;

ALTER TABLE "invoice_item" ADD COLUMN "vatTreatment" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "vatCountry" TEXT,
  ADD COLUMN "vatReasonCode" TEXT,
  ADD COLUMN "quantityInput" TEXT,
  ADD COLUMN "unitPriceInput" TEXT,
  ADD COLUMN "inputPrecision" TEXT;

-- Recover the entered price's side from the parent document; no amounts are recalculated.
UPDATE "invoice_item" AS line SET
  "vatTreatment" = CASE WHEN line."taxRate" > 0 THEN 'standard' ELSE 'unclassified_zero' END,
  "quantityInput" = line."quantity"::text,
  "unitPriceInput" = CASE WHEN document."pricesIncludeTax" THEN line."unitPriceGross" ELSE line."unitPriceNet" END::text,
  "inputPrecision" = 'backfilled'
FROM "invoice" AS document WHERE document.id = line."invoiceId";

ALTER TABLE "quote_item" ADD COLUMN "vatTreatment" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "vatCountry" TEXT,
  ADD COLUMN "vatReasonCode" TEXT,
  ADD COLUMN "quantityInput" TEXT,
  ADD COLUMN "unitPriceInput" TEXT,
  ADD COLUMN "inputPrecision" TEXT;

-- Recover the entered price's side from the parent document; no amounts are recalculated.
UPDATE "quote_item" AS line SET
  "vatTreatment" = CASE WHEN line."taxRate" > 0 THEN 'standard' ELSE 'unclassified_zero' END,
  "quantityInput" = line."quantity"::text,
  "unitPriceInput" = CASE WHEN document."pricesIncludeTax" THEN line."unitPriceGross" ELSE line."unitPriceNet" END::text,
  "inputPrecision" = 'backfilled'
FROM "quote" AS document WHERE document.id = line."quoteId";

ALTER TABLE "credit_note_item" ADD COLUMN "vatTreatment" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "vatCountry" TEXT,
  ADD COLUMN "vatReasonCode" TEXT,
  ADD COLUMN "quantityInput" TEXT,
  ADD COLUMN "unitPriceInput" TEXT,
  ADD COLUMN "inputPrecision" TEXT;

-- Recover the entered price's side from the parent document; no amounts are recalculated.
UPDATE "credit_note_item" AS line SET
  "vatTreatment" = CASE WHEN line."taxRate" > 0 THEN 'standard' ELSE 'unclassified_zero' END,
  "quantityInput" = line."quantity"::text,
  "unitPriceInput" = CASE WHEN document."pricesIncludeTax" THEN line."unitPriceGross" ELSE line."unitPriceNet" END::text,
  "inputPrecision" = 'backfilled'
FROM "credit_note" AS document WHERE document.id = line."creditNoteId";

ALTER TABLE "deliverable" ADD COLUMN "vatTreatment" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "vatCountry" TEXT,
  ADD COLUMN "vatReasonCode" TEXT,
  ADD COLUMN "quantityInput" TEXT,
  ADD COLUMN "unitPriceInput" TEXT,
  ADD COLUMN "inputPrecision" TEXT;

-- Recover the entered price's side from the parent document; no amounts are recalculated.
UPDATE "deliverable" AS line SET
  "vatTreatment" = CASE WHEN line."taxRate" > 0 THEN 'standard' ELSE 'unclassified_zero' END,
  "quantityInput" = line."quantity"::text,
  "unitPriceInput" = CASE WHEN document."pricesIncludeTax" THEN line."unitPriceGross" ELSE line."unitPriceNet" END::text,
  "inputPrecision" = 'backfilled'
FROM "agreement" AS document WHERE document.id = line."agreementId";
