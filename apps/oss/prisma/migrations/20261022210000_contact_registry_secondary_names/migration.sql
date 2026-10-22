-- A CVR customer may be invoiced under one of the company's registered secondary names (binavne).
ALTER TABLE "contact" ADD COLUMN "registrySecondaryNames" TEXT[] DEFAULT ARRAY[]::TEXT[];
