import type { Prisma } from "../../generated/prisma/client"
import { prisma } from "../lib/db"
import { getDocumentArtifactStore, type DocumentArtifactStore } from "../lib/runtime/services"
import type { StoredArtifacts } from "./documents/artifacts"

const storedRefs = (artifacts: unknown) => {
  const value = artifacts as StoredArtifacts | null
  return value?.pdf ? [value.pdf.ref, ...(value.ubl ? [value.ubl.ref] : [])] : []
}

/** Every stored file the database still points at for these organizations. */
async function artifactRefs(db: Prisma.TransactionClient, scope: { organizationId: { in: string[] } }) {
  const select = { artifactPdfRef: true, artifactUblRef: true } as const
  const documents = [
    ...await db.invoice.findMany({ where: scope, select }),
    ...await db.creditNote.findMany({ where: scope, select }),
    ...await db.agreement.findMany({ where: scope, select }),
  ]
  const staged = [
    ...await db.artifactStaging.findMany({ where: scope, select: { artifacts: true } }),
    ...await db.issuanceCandidate.findMany({ where: scope, select: { artifacts: true } }),
  ]
  return [...new Set([
    ...documents.flatMap(row => [row.artifactPdfRef, row.artifactUblRef]),
    ...staged.flatMap(row => storedRefs(row.artifacts)),
  ].filter((ref): ref is string => Boolean(ref)))]
}

/**
 * Hard-deletes every row the organizations own, child tables first. Members, users and sessions
 * are left to the caller. Test fixtures share this order with `purgeOrganization`.
 */
export async function deleteOrganizationRows(db: Prisma.TransactionClient, ids: string[]) {
  const scope = { organizationId: { in: ids } }
  const kinds = [
    ["invoice", await db.invoice.findMany({ where: scope, select: { id: true } })],
    ["quote", await db.quote.findMany({ where: scope, select: { id: true } })],
    ["agreement", await db.agreement.findMany({ where: scope, select: { id: true } })],
    ["creditNote", await db.creditNote.findMany({ where: scope, select: { id: true } })],
  ] as const
  await db.publicLinkAttempt.deleteMany({ where: { OR: kinds.map(([documentKind, rows]) => ({
    documentKind, documentId: { in: rows.map(({ id }) => id) },
  })) } })
  await db.issuanceCandidate.deleteMany({ where: scope })
  await db.artifactStaging.deleteMany({ where: scope })
  await db.approvalRequest.deleteMany({ where: scope })
  await db.agentKey.deleteMany({ where: scope })
  await db.deliverableRebill.deleteMany({ where: { agreement: scope } })
  await db.creditNoteItem.deleteMany({ where: { creditNote: scope } })
  await db.creditNote.deleteMany({ where: scope })
  await db.paymentRefund.deleteMany({ where: scope })
  await db.payment.deleteMany({ where: scope })
  await db.settlementRefund.deleteMany({ where: { receipt: scope } })
  await db.settlementReceipt.deleteMany({ where: scope })
  await db.invoiceReminder.deleteMany({ where: { invoice: scope } })
  await db.invoiceItem.deleteMany({ where: { invoice: scope } })
  await db.invoice.deleteMany({ where: scope })
  await db.deliverable.deleteMany({ where: { agreement: scope } })
  await db.agreement.deleteMany({ where: scope })
  await db.agreementTemplate.deleteMany({ where: scope })
  await db.quoteItem.deleteMany({ where: { quote: scope } })
  await db.quote.deleteMany({ where: scope })
  await db.recurringInvoice.deleteMany({ where: scope })
  await db.learnedDefaultClear.deleteMany({ where: scope })
  await db.contact.deleteMany({ where: scope })
  await db.organizationTaxId.deleteMany({ where: scope })
  await db.orgSettings.deleteMany({ where: scope })
  await db.domainEvent.deleteMany({ where: scope })
  await db.job.deleteMany({ where: scope })
  await db.commandReceipt.deleteMany({ where: scope })
  // Members, invitations, catalog items and the remaining per-organization tables cascade.
  await db.organization.deleteMany({ where: { id: { in: ids } } })
}

export type OrganizationPurgeResult = { purged: boolean; artifacts: number; users: number }

/**
 * Permanently deletes an organization: its stored files, every row it owns, and the users whose only
 * membership it was. Other users keep their accounts and lose only this membership.
 *
 * Safe to re-run after a failure. Files go first so a later run can still find their refs; a file
 * that is already gone counts as deleted. A purge of an organization that no longer exists does nothing.
 */
export async function purgeOrganization(
  organizationId: string,
  { artifactStore = getDocumentArtifactStore() }: { artifactStore?: DocumentArtifactStore | null } = {},
): Promise<OrganizationPurgeResult> {
  if (!await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } })) {
    return { purged: false, artifacts: 0, users: 0 }
  }
  const refs = await artifactRefs(prisma, { organizationId: { in: [organizationId] } })
  if (refs.length && !artifactStore) throw new Error("Organization purge requires the document artifact store")
  for (const ref of refs) await artifactStore!.delete(ref)

  return prisma.$transaction(async db => {
    // Serializes concurrent purges; the second one finds nothing left to delete.
    const locked = await db.$queryRaw<unknown[]>`SELECT id FROM "organization" WHERE id = ${organizationId} FOR UPDATE`
    if (!locked.length) return { purged: false, artifacts: refs.length, users: 0 }
    const members = await db.member.findMany({ where: { organizationId }, select: { userId: true } })
    const elsewhere = await db.member.findMany({
      where: { userId: { in: members.map(({ userId }) => userId) }, organizationId: { not: organizationId } },
      select: { userId: true },
    })
    const kept = new Set(elsewhere.map(({ userId }) => userId))
    const soleMembers = members.map(({ userId }) => userId).filter(userId => !kept.has(userId))

    await deleteOrganizationRows(db, [organizationId])
    await db.session.updateMany({ where: { activeOrganizationId: organizationId }, data: { activeOrganizationId: null } })
    // Sessions, accounts and invitations they sent cascade with the user.
    const users = await db.user.deleteMany({ where: { id: { in: soleMembers } } })
    return { purged: true, artifacts: refs.length, users: users.count }
  }, { timeout: 30_000 })
}
