export type DocumentPrefixes = { invoicePrefix?: string | null; creditNotePrefix?: string | null }
export type DocumentPrefixField = keyof DocumentPrefixes

export const normalizeDocumentPrefix = (prefix: string | null | undefined) => prefix?.trim().toUpperCase() ?? ""

/** The prefixes a save changes. Settings sends both, so an unchanged one must not count. */
export function changedDocumentPrefixes(stored: DocumentPrefixes, next: DocumentPrefixes): DocumentPrefixField[] {
  return (["invoicePrefix", "creditNotePrefix"] as const).filter(field =>
    next[field] !== undefined && normalizeDocumentPrefix(next[field]) !== normalizeDocumentPrefix(stored[field]))
}

/**
 * A credit note is an invoice in law, so its number must never equal an invoice number. The two
 * series keep separate counters, so equal prefixes would let them collide. Organizations that
 * already have equal prefixes can still save other settings; only changing a prefix is refused
 * while the two stay equal. Returns the changed fields that conflict, for the server and the form.
 */
export function conflictingDocumentPrefixes(stored: DocumentPrefixes, next: DocumentPrefixes): DocumentPrefixField[] {
  const changed = changedDocumentPrefixes(stored, next)
  if (!changed.length) return []
  const invoicePrefix = normalizeDocumentPrefix(next.invoicePrefix ?? stored.invoicePrefix)
  return invoicePrefix && invoicePrefix === normalizeDocumentPrefix(next.creditNotePrefix ?? stored.creditNotePrefix) ? changed : []
}
