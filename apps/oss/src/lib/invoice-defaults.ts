/** The VAT rate (a percentage) a new line starts at: zero for a seller who is not VAT-registered, else the policy or configured rate. */
export function defaultDocumentTaxRate(readiness: { momsRegistered?: boolean | null; standardVatRate?: string | null; taxRate: string }): string {
  return readiness.momsRegistered === false ? "0" : readiness.standardVatRate ?? readiness.taxRate
}
