import { Effect } from "effect"
import { z } from "zod"
import { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { defineCommand } from "../command"
import { executeCommand } from "../execute"
import { schedulerActor, utcTimestamp } from "../commands/reminders"
import { lockDocument } from "../documents/locks"
import { Command, Db } from "../services"
import {
  DEFAULT_ORGANIZATION_BUDGET,
  forEachOrganizationWithinBudget,
  organizationSqlFilter,
  registerTickTask,
  scannedOrganizationSource,
  type TickOptions,
  type OrganizationBudget,
} from "../scheduler"

export const expireOrganizationAgreements = defineCommand({
  type: "agreement.expire",
  permission: "agreement:update",
  outwardFacing: false,
  input: z.object({}).strict(),
  summarize: () => "Expire agreement offers",
  handle: () =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const candidates = yield* Effect.promise(() =>
        db.agreement.findMany({
          where: {
            organizationId: command.organizationId,
            status: "sent",
            expiresAt: { lte: command.now },
            OR: [
              { lastEmailAttemptOutcome: null },
              { lastEmailAttemptOutcome: { not: "sending" } },
            ],
          },
          orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
          take: 200,
          select: { id: true },
        }),
      )
      let marked = 0
      for (const candidate of candidates) {
        yield* lockDocument("agreement", candidate.id, { strength: "update" })
        const changed = yield* Effect.promise(() =>
          db.agreement.updateMany({
            where: {
              id: candidate.id,
              organizationId: command.organizationId,
              status: "sent",
              expiresAt: { lte: command.now },
              OR: [
                { lastEmailAttemptOutcome: null },
                { lastEmailAttemptOutcome: { not: "sending" } },
              ],
            },
            data: { status: "expired" },
          }),
        )
        if (changed.count) {
          marked += 1
          command.emit({
            aggregateType: "agreement",
            aggregateId: candidate.id,
            type: "agreement.expired",
            payload: {},
          })
        }
      }
      return { marked, more: candidates.length === 200 }
    }),
})
export async function runAgreementExpiryTask(
  now = new Date(),
  options?: TickOptions,
  budget: OrganizationBudget = DEFAULT_ORGANIZATION_BUDGET,
) {
  let marked = 0,
    failed = 0,
    remaining = 0
  const source = scannedOrganizationSource(
    "agreement-expiry",
    Prisma.sql`SELECT "organizationId" FROM "agreement" WHERE "status" = 'sent' AND "expiresAt" <= ${utcTimestamp(now)} AND ("lastEmailAttemptOutcome" IS NULL OR "lastEmailAttemptOutcome" != 'sending') ${organizationSqlFilter(Prisma.sql`"organizationId"`, options)}`,
  )
  const result = await forEachOrganizationWithinBudget(
    source,
    async (organizationId) => {
      try {
        const outcome = await executeCommand(
          expireOrganizationAgreements,
          {},
          { actor: schedulerActor(organizationId), now },
        )
        if (outcome.status !== "completed") {
          failed += 1
          return
        }
        marked += outcome.result.marked
        if (outcome.result.more) remaining += 1
      } catch {
        failed += 1
      }
    },
    budget,
  )
  return {
    organizations: result.organizations,
    marked,
    failed,
    remaining: remaining + result.deferred,
  }
}
registerTickTask({ name: "agreement-expiry", order: 15, run: runAgreementExpiryTask })
export async function sweepPublicLinkAttempts(now: Date) {
  const result = await prisma.publicLinkAttempt.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - 24 * 3600_000) } },
  })
  return { removed: result.count }
}
registerTickTask({ name: "public-link-attempts", order: 20, run: sweepPublicLinkAttempts })
