import { Effect } from "effect"
import { z } from "zod"
import { prisma } from "../../lib/db"
import { appLogger } from "../../lib/observability"
import { schedulerActor } from "../commands/reminders"
import { defineCommand } from "../command"
import { computeSettlement } from "../documents/settlement"
import { executeCommand } from "../execute"
import { registerTickTask } from "../scheduler"
import { Command, Db } from "../services"

const overdueLogger = appLogger.child("overdue")

/** Issued invoices that turn overdue once their due date passes with a balance due. */
const PRE_OVERDUE_STATUSES = ["sent", "viewed"]

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

      const candidates = yield* Effect.promise(() =>
        db.invoice.findMany({
          where: { organizationId, status: { in: PRE_OVERDUE_STATUSES }, dueDate: { lt: now } },
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

      return { marked }
    }),
})

/** Marks overdue invoices across every organization. */
export async function runOverdueTask(now: Date = new Date()) {
  const organizations = await prisma.invoice.findMany({
    where: { status: { in: PRE_OVERDUE_STATUSES }, dueDate: { lt: now } },
    distinct: ["organizationId"],
    select: { organizationId: true },
  })

  let marked = 0
  let failed = 0
  for (const { organizationId } of organizations) {
    try {
      const outcome = await executeCommand(
        markOrganizationInvoicesOverdue,
        {},
        { actor: schedulerActor(organizationId), now }
      )
      if (outcome.status === "completed") {
        marked += outcome.result.marked
      } else {
        failed += 1
      }
    } catch (error) {
      failed += 1
      overdueLogger.error("overdue.organization_failed", { organizationId, error })
    }
  }

  return { organizations: organizations.length, marked, failed }
}

registerTickTask({ name: "overdue", order: 10, run: runOverdueTask })
