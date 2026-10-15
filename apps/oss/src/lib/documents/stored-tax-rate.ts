/** The document rate an edit form shows: the rate the document stored, never a default. */
export function storedDocumentTaxRate(items: ReadonlyArray<{ taxRate?: number | string | null }>): string {
  return String(items.find((item) => Number(item.taxRate) > 0)?.taxRate ?? 0)
}
