import type { Prisma } from "../../generated/prisma/client"
import { changedDocumentPrefixes, conflictingDocumentPrefixes, type DocumentPrefixes, type DocumentPrefixField } from "../lib/document-prefixes"
import { translate } from "../lib/i18n/translate"
import { toTrpcError } from "./outcome"

function prefixConflict(fields: DocumentPrefixField[], locale: string | null | undefined) {
  return toTrpcError({
    tag: "InvalidState",
    code: "document_prefix_conflict",
    message: translate("settings.validation.prefixConflict", locale),
    fieldIssues: fields.map(field => ({ code: "prefix.conflict", field, params: {} })),
  })
}

/** Refuses a save that leaves invoices and credit notes with equal prefixes; see `conflictingDocumentPrefixes`. */
export function assertDistinctDocumentPrefixes(stored: DocumentPrefixes, next: DocumentPrefixes, locale: string | null | undefined) {
  const conflicts = conflictingDocumentPrefixes(stored, next)
  if (conflicts.length) throw prefixConflict(conflicts, locale)
}

/**
 * Distinct current prefixes are not enough once a series has moved on: after invoices change from
 * FAK to INV, a credit-note prefix of FAK would number the next credit note FAK-0001, which an
 * invoice already has. A changed prefix is refused while the other series has a number starting
 * with it and a hyphen. Unchanged prefixes are not checked, so other settings still save.
 */
export async function assertDocumentPrefixesUnused(
  db: Pick<Prisma.TransactionClient, "invoice" | "creditNote">,
  organizationId: string,
  stored: DocumentPrefixes,
  next: DocumentPrefixes,
  locale: string | null | undefined,
) {
  const used: DocumentPrefixField[] = []
  for (const field of changedDocumentPrefixes(stored, next)) {
    const where = { organizationId, number: { startsWith: `${next[field]!.trim()}-`, mode: "insensitive" as const } }
    const other = field === "invoicePrefix"
      ? await db.creditNote.findFirst({ where, select: { id: true } })
      : await db.invoice.findFirst({ where, select: { id: true } })
    if (other) used.push(field)
  }
  if (used.length) throw prefixConflict(used, locale)
}
