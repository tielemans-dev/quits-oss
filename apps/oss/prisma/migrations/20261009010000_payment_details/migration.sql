-- Bank details an organization prints on its invoices. All columns are optional: an organization
-- that has not entered any behaves exactly as before.
ALTER TABLE "org_settings" ADD COLUMN     "bankAccountHolder" TEXT,
ADD COLUMN     "bankAccountNumber" TEXT,
ADD COLUMN     "bankBic" TEXT,
ADD COLUMN     "bankIban" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "bankRegNumber" TEXT,
ADD COLUMN     "paymentNote" TEXT;
