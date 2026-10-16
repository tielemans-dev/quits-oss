import type { Prisma, PrismaClient } from "../../../generated/prisma/client"
import { assertOrganizationCvrAvailable } from "../runtime/cvr-admission"
import { getBillingProvider } from "../runtime/services"
import { requireOnboardingCvr } from "./require-cvr"

type CvrInput = Parameters<typeof requireOnboardingCvr>[0]
type Company = Awaited<ReturnType<typeof requireOnboardingCvr>>

export async function recordCvrVerification(db: Prisma.TransactionClient, organizationId: string, cvr: string, verified: boolean) {
  const data = { cvr, status: verified ? "verified" as const : "pending" as const,
    checkedAt: verified ? new Date() : null, nextAttemptAt: new Date(), lastError: null }
  await db.organizationCvrVerification.upsert({ where: { organizationId },
    create: { organizationId, ...data }, update: data })
}

/** Only onboarding tolerates outages. Format, unknown and ceased results still refuse admission. */
export async function admitOnboardingCvr(input: CvrInput) {
  const db = input.tx
  let company: Company = null
  try { company = await requireOnboardingCvr(input) } catch (error) {
    if (!(error instanceof Error) || error.message !== "cvr.unavailable") throw error
  }
  if (input.cloud && db && input.organizationId) {
    if (!company) await assertOrganizationCvrAvailable(db, { cvr: input.cvr as string, organizationId: input.organizationId, cloud: true })
    await recordCvrVerification(db, input.organizationId, input.cvr as string, company !== null)
  }
  return company
}

/** Login retries only the user's organizations, with a durable lease and no registry call under a lock. */
export async function retryPendingCvrVerifications(db: PrismaClient, userId: string) {
  const now = new Date()
  const pending = await db.organizationCvrVerification.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now }, organization: { members: { some: { userId } }, settings: { onboardingCompletedAt: { not: null } } } },
    orderBy: { nextAttemptAt: "asc" }, take: 2,
  })
  for (const row of pending) {
    const nextAttemptAt = new Date(Date.now() + 5 * 60_000)
    const where = { organizationId: row.organizationId, cvr: row.cvr, status: "pending" as const,
      nextAttemptAt: { lte: now } }
    const claimed = await db.organizationCvrVerification.updateMany({ where, data: { nextAttemptAt } })
    if (!claimed.count) continue
    let status: "verified" | "invalid" | "inactive" = "verified"
    try {
      await requireOnboardingCvr({ cvr: row.cvr, cloud: true, userId, organizationId: row.organizationId })
    } catch (error) {
      if (!(error instanceof Error) || !["cvr.invalid", "cvr.inactive"].includes(error.message)) continue
      status = error.message === "cvr.invalid" ? "invalid" : "inactive"
    }
    // Terminal invalid/inactive results are the handoff to QUI-154; no account enforcement here.
    try {
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM organization WHERE id = ${row.organizationId} FOR NO KEY UPDATE`
        if (status === "verified") await assertOrganizationCvrAvailable(tx, { cvr: row.cvr, organizationId: row.organizationId, cloud: true })
        const updated = await tx.organizationCvrVerification.updateMany({
          where: { ...where, nextAttemptAt }, data: { status, checkedAt: new Date(), lastError: null },
        })
        if (updated.count && status === "verified") await getBillingProvider().startTrial?.(row.organizationId, { cvr: row.cvr, cvrVerified: true, tx })
      })
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "cvr.alreadyRegistered") throw error
      await db.organizationCvrVerification.updateMany({ where: { ...where, nextAttemptAt },
        data: { lastError: "cvr.alreadyRegistered", checkedAt: new Date() } })
    }
  }
}
