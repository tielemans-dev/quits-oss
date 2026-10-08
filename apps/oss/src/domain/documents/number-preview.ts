import { prisma } from "../../lib/db"
import { NUMBER_SETTINGS_SELECT, nextNumberFromSettings, type NumberedDocumentKind } from "./numbering"

/**
 * The number the next document of this kind will receive, for display next to a draft. It is not
 * reserved: another document may be issued first, so label it as the number "when sent".
 */
export async function previewNextDocumentNumber(organizationId: string, kind: NumberedDocumentKind) {
  const settings = await prisma.orgSettings.findUnique({ where: { organizationId }, select: NUMBER_SETTINGS_SELECT })
  return nextNumberFromSettings(kind, settings)
}
