import { translate } from "../lib/i18n/translate"
import { toTrpcError } from "./outcome"

type Prefixes = { invoicePrefix?: string | null; creditNotePrefix?: string | null }

const normalize = (prefix: string | null | undefined) => prefix?.trim().toUpperCase() ?? ""

/**
 * A credit note is an invoice in law, so its number must never equal an invoice number. The two
 * series keep separate counters, so equal prefixes would let them collide. Organizations that
 * already have equal prefixes can still save other settings; only changing a prefix is refused
 * while the two stay equal.
 */
export function assertDistinctDocumentPrefixes(stored: Prefixes, next: Prefixes, locale: string | null | undefined) {
  const changed = (["invoicePrefix", "creditNotePrefix"] as const).filter(field =>
    next[field] !== undefined && normalize(next[field]) !== normalize(stored[field]))
  if (!changed.length) return
  const invoicePrefix = normalize(next.invoicePrefix ?? stored.invoicePrefix)
  if (!invoicePrefix || invoicePrefix !== normalize(next.creditNotePrefix ?? stored.creditNotePrefix)) return
  throw toTrpcError({
    tag: "InvalidState",
    code: "document_prefix_conflict",
    message: translate("settings.validation.prefixConflict", locale),
    fieldIssues: changed.map(field => ({ code: "prefix.conflict", field, params: {} })),
  })
}
