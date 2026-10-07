import { Effect } from "effect"
import { z } from "zod"
import { Prisma } from "../../../generated/prisma/client"
import { appLogger } from "../../lib/observability"
import { schedulerActor, utcTimestamp } from "../commands/reminders"
import { defineCommand } from "../command"
import { computeSettlement } from "../documents/settlement"
import { executeCommand } from "../execute"
import {
  DEFAULT_ORGANIZATION_BUDGET,
  forEachOrganizationWithinBudget,
  organizationSqlFilter,
  registerTickTask,
  scannedOrganizationSource,
  type OrganizationBudget,
  type OrganizationSource,
  type TickOptions,
} from "../scheduler"
import { Command, Db } from "../services"

const overdueLogger = appLogger.child("overdue")

/** Issued invoices that turn overdue once their due date passes with a balance due. */
const PRE_OVERDUE_STATUSES = ["sent", "viewed"]

/** Invoices one command marks; an organization with more is continued next tick. */
export const OVERDUE_BATCH_SIZE = 200

/**
 * Marks an organization's issued invoices overdue. Runs as the scheduler so every change is
 * audited as `invoice.became_overdue`. The conditional update makes it idempotent and safe
 * against overlapping ticks.
 */
export const markOrganizationInvoicesOverdue = defineCommand({
  type: "invoice.mark_overdue",
  permission: "invoice:update",
  outwardFacing: false,
  input: z.object({}),
  summarize: () => "Mark invoices past their due date as overdue",
  handle: () =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command

      // Settled invoices are excluded in SQL so they never fill the batch tick after tick.
      const batch = yield* Effect.promise(() =>
        db.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "invoice"
          WHERE "organizationId" = ${organizationId}
            AND "status" IN (${Prisma.join(PRE_OVERDUE_STATUSES)})
            AND "dueDate" < ${utcTimestamp(now)}
            AND "totalGross" - "amountCredited" - "amountPaid" > 0
          ORDER BY "dueDate" ASC, "id" ASC
          LIMIT ${OVERDUE_BATCH_SIZE}
        `
      )
      const candidates = yield* Effect.promise(() =>
        db.invoice.findMany({
          where: { id: { in: batch.map((row) => row.id) }, organizationId },
          orderBy: { dueDate: "asc" },
          select: {
            id: true,
            number: true,
            status: true,
            dueDate: true,
            totalGross: true,
            amountPaid: true,
            amountCredited: true,
          },
        })
      )

      let marked = 0
      for (const invoice of candidates) {
        const { balanceDue } = computeSettlement(invoice)
        if (!balanceDue.greaterThan(0)) {
          continue
        }
        const updated = yield* Effect.promise(() =>
          db.invoice.updateMany({
            where: { id: invoice.id, status: { in: PRE_OVERDUE_STATUSES } },
            data: { status: "overdue" },
          })
        )
        if (updated.count === 0) {
          continue
        }
        marked += 1
        command.emit({
          aggregateType: "invoice",
          aggregateId: invoice.id,
          type: "invoice.became_overdue",
          payload: {
            number: invoice.number,
            previousStatus: invoice.status,
            dueDate: invoice.dueDate.toISOString(),
            balanceDue: balanceDue.toNumber(),
          },
        })
      }

      return { marked, more: batch.length === OVERDUE_BATCH_SIZE }
    }),
})

/**
 * Organizations with at least one invoice the command would mark: issued, past due, and with a
 * balance due (the same predicate as the command's batch, so settled invoices never make an
 * organization eligible). Claimed in the database, least recently scanned first.
 */
export function overdueOrganizations(now: Date, options?: TickOptions): OrganizationSource {
  return scannedOrganizationSource(
    "overdue",
    Prisma.sql`
      SELECT "organizationId" FROM "invoice"
      WHERE "status" IN (${Prisma.join(PRE_OVERDUE_STATUSES)})
        AND "dueDate" < ${utcTimestamp(now)}
        AND "totalGross" - "amountCredited" - "amountPaid" > 0
        ${organizationSqlFilter(Prisma.sql`"organizationId"`, options)}
    `
  )
}

/**
 * Marks overdue invoices across organizations, at most one batch per organization per tick and
 * within the tick's organization budget; the rest is picked up by the next tick.
 */
export async function runOverdueTask(
  now: Date = new Date(),
  options?: TickOptions,
  budget: OrganizationBudget = DEFAULT_ORGANIZATION_BUDGET
) {
  let marked = 0
  let failed = 0
  let remaining = 0
  const { organizations, deferred } = await forEachOrganizationWithinBudget(
    overdueOrganizations(now, options),
    async (organizationId) => {
      try {
        const outcome = await executeCommand(
          markOrganizationInvoicesOverdue,
          {},
          { actor: schedulerActor(organizationId), now }
        )
        if (outcome.status === "completed") {
          marked += outcome.result.marked
          if (outcome.result.more) remaining += 1
        } else {
          failed += 1
        }
      } catch (error) {
        failed += 1
        overdueLogger.error("overdue.organization_failed", { organizationId, error })
      }
    },
    budget
  )

  return { organizations, marked, failed, remaining: remaining + deferred }
}

registerTickTask({ name: "overdue", order: 10, run: runOverdueTask })
