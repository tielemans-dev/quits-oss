import { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { getDocumentArtifactStore } from "../../lib/runtime/services"
import { appendEvents } from "../events"
import { schedulerActor, utcTimestamp } from "../commands/reminders"
import { lockArtifactOrganization, type StoredArtifacts } from "../documents/artifacts"
import type { PendingEvent } from "../services"
import { registerTickTask, scannedOrganizationSource, forEachOrganizationWithinBudget,
  organizationSqlFilter, type TickOptions } from "../scheduler"

export const RETIRED_ARTIFACT_RETENTION_MS = 7 * 24 * 3600_000
const refs = (artifacts: unknown) => {
  const value = artifacts as StoredArtifacts | null
  return value ? [value.pdf.ref, ...(value.ubl ? [value.ubl.ref] : [])] : []
}
/** The organization lock fences publication, reuse and deletion against each other. */
export async function sweepOrganizationArtifacts(organizationId: string, now = new Date()) {
  return prisma.$transaction(async tx => {
    await lockArtifactOrganization(tx, organizationId)
    const rows = await tx.artifactStaging.findMany({ where: {
      organizationId, OR: [
        { status: { in: ["reserved", "stored", "missing"] }, leaseUntil: { lte: now } },
        { status: "candidate_bound", leaseUntil: { lte: now }, candidates: { some: {}, every: { status: "retired" } } },
        { status: "abandoned", artifacts: { not: Prisma.DbNull },
          candidates: { none: { status: "retired", createdAt: { gt: new Date(now.getTime() - RETIRED_ARTIFACT_RETENTION_MS) } } } },
      ],
    }, include: { candidates: true }, orderBy: { createdAt: "asc" }, take: 200 })
    const events: PendingEvent[] = []
    let abandoned = 0, deleted = 0
    for (const row of rows) {
      if (row.status !== "abandoned") {
        const noCandidateExpired = row.leaseUntil <= now && !row.candidates.length
        // Preserve the promised unchanged retry for the entire preparation lease.
        const allRetired = row.leaseUntil <= now && row.candidates.length > 0 && row.candidates.every(candidate => candidate.status === "retired")
        if (!noCandidateExpired && !allRetired) continue
        // A failed runner may still have a provider decision waiting for settlement.
        const jobs = row.candidates.length ? await tx.job.findMany({ where: { organizationId, type: "email.deliver",
          OR: row.candidates.map(candidate => ({ payload: { path: ["completion", "target", "candidateId"], equals: candidate.id } })),
        }, select: { status: true, result: true } }) : []
        if (jobs.some(job => ["pending", "queued"].includes(job.status) || job.status === "running" || job.result === null)) continue
        await tx.artifactStaging.update({ where: { id: row.id }, data: { status: "abandoned", prepToken: null } })
        abandoned++
        // An agreement offer issued before queueing already owns its number, even on rejection.
        const offerOwnsNumber = row.documentKind === "agreement" && !!await tx.agreement.findFirst({
          where: { id: row.documentId, organizationId, number: row.reservedNumber, offerSnapshot: { not: Prisma.DbNull } }, select: { id: true },
        })
        if (row.numberWasAllocated && !offerOwnsNumber) {
          const documentKind = row.documentKind
          const number = row.reservedNumber!
          const reservationId = row.id
          const reason = noCandidateExpired ? "reservation_expired" : "delivery_retired"
          events.push({ aggregateType: "document", aggregateId: row.documentId, type: "document.number_voided",
            payload: { organizationId, documentKind, number, reservationId, reason } })
        }
      }
      const store = getDocumentArtifactStore()
      if (!store) continue
      const oldestProtected = new Date(now.getTime() - RETIRED_ARTIFACT_RETENTION_MS)
      const protectedStaging = await tx.artifactStaging.findMany({ where: {
        organizationId, status: { in: ["candidate_bound", "published", "reserved", "stored"] },
      }, select: { artifacts: true } })
      const protectedCandidates = await tx.issuanceCandidate.findMany({ where: {
        organizationId, status: "retired", createdAt: { gt: oldestProtected },
      }, select: { artifacts: true } })
      const protectedRefs = new Set([...protectedStaging, ...protectedCandidates].flatMap(value => refs(value.artifacts)))
      const toDelete = refs(row.artifacts).filter(ref => !protectedRefs.has(ref))
      for (const ref of toDelete) { await store.delete(ref); deleted++ }
      if (toDelete.length && toDelete.length === refs(row.artifacts).length) {
        await tx.artifactStaging.update({ where: { id: row.id }, data: { artifacts: Prisma.DbNull } })
      }
    }
    await appendEvents(tx, { organizationId, actor: schedulerActor(organizationId), commandId: null, approvedByUserId: null,
      occurredAt: now, events })
    return { abandoned, deleted, more: rows.length === 200 ? 1 : 0 }
  }, { maxWait: 10_000, timeout: 60_000 })
}
export async function runArtifactSweep(now = new Date(), options?: TickOptions) {
  const source = scannedOrganizationSource("document-artifacts", Prisma.sql`
    SELECT "organizationId" FROM "artifact_staging" WHERE (
      ("status" IN ('reserved', 'stored', 'missing') AND "leaseUntil" <= ${utcTimestamp(now)})
      OR ("status" = 'candidate_bound' AND "leaseUntil" <= ${utcTimestamp(now)}
        AND EXISTS (SELECT 1 FROM "issuance_candidate" c WHERE c."stagingId" = "artifact_staging".id)
        AND NOT EXISTS (SELECT 1 FROM "issuance_candidate" c WHERE c."stagingId" = "artifact_staging".id AND c.status != 'retired'))
      OR ("status" = 'abandoned' AND artifacts IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "issuance_candidate" c WHERE c."stagingId" = "artifact_staging".id
          AND c.status = 'retired' AND c."createdAt" > ${utcTimestamp(new Date(now.getTime() - RETIRED_ARTIFACT_RETENTION_MS))}))
    ) ${organizationSqlFilter(Prisma.sql`"organizationId"`, options)}`)
  let abandoned = 0, deleted = 0, failed = 0, more = 0
  const result = await forEachOrganizationWithinBudget(source, async organizationId => {
    try { const swept = await sweepOrganizationArtifacts(organizationId, now); abandoned += swept.abandoned; deleted += swept.deleted; more += swept.more }
    catch { failed++ }
  })
  return { organizations: result.organizations, remaining: result.deferred + more, abandoned, deleted, failed }
}
registerTickTask({ name: "document-artifacts", order: 30, run: runArtifactSweep })
