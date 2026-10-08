import { prisma } from "../../lib/db"
import { formatDocumentNumber, type NumberedDocumentKind } from "./numbering"

const DEFAULTS = {
  agreement: ["AGR", "agreementPrefix", "agreementNextNum"],
  invoice: ["INV", "invoicePrefix", "invoiceNextNum"],
  quote: ["QTE", "quotePrefix", "quoteNextNum"],
  creditNote: ["CN", "creditNotePrefix", "creditNoteNextNum"],
} as const

/**
 * The number the next document of this kind will receive, for display next to a draft. It is not
 * reserved: another document may be issued first, so label it as the number "when sent".
 */
export async function previewNextDocumentNumber(organizationId: string, kind: NumberedDocumentKind) {
  const [fallbackPrefix, prefixField, nextField] = DEFAULTS[kind]
  const settings = await prisma.orgSettings.findUnique({
    where: { organizationId },
    select: { [prefixField]: true, [nextField]: true },
  }) as Record<string, string | number> | null
  return formatDocumentNumber(String(settings?.[prefixField] ?? fallbackPrefix), Number(settings?.[nextField] ?? 1))
}
