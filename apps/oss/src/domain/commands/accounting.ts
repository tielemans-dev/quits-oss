import { Effect } from "effect"
import { z } from "zod"
import { Prisma } from "../../../generated/prisma/client"
import { disconnectAccounting } from "../accounting/connections"
import { defineCommand } from "../command"
import { InvalidState, NotFound } from "../errors"
import { advance } from "../events/consumers"
import { Command, Db } from "../services"

export const disconnectAccountingCommand = defineCommand({
  type: "accounting.disconnect", permission: "settings:update", outwardFacing: false,
  input: z.object({}), summarize: () => "Disconnect accounting",
  handle: () => Effect.gen(function* () {
    const db = yield* Db, command = yield* Command
    const connection = yield* Effect.promise(() => db.accountingConnection.findUnique({
      where: { organizationId: command.organizationId }, select: { provider: true, generation: true, status: true },
    }))
    if (!connection || connection.status === "disconnected") return
    yield* Effect.promise(() => disconnectAccounting(command.organizationId, db))
    command.emit({ aggregateType: "organization", aggregateId: command.organizationId,
      type: "accounting.action_recorded", payload: { action: "disconnect", provider: connection.provider, generation: connection.generation, deliveryId: null, reason: null } })
  }),
})

export const retryAccountingInput = z.object({ deliveryId: z.string().min(1) })
export const skipAccountingInput = retryAccountingInput.extend({ reason: z.string().trim().min(1).max(500) })

function deliveryCommand(action: "retry" | "skip") {
  return defineCommand({
    type: `accounting.${action}`, permission: "settings:update", outwardFacing: false,
    input: action === "skip" ? skipAccountingInput : retryAccountingInput,
    summarize: () => `${action === "retry" ? "Retry" : "Skip"} failed accounting delivery`,
    handle: (input) => Effect.gen(function* () {
      const db = yield* Db, command = yield* Command
      const connection = yield* Effect.promise(() => db.accountingConnection.findFirst({
        where: { organizationId: command.organizationId, status: "connected", credentialEnc: { not: null } },
        select: { provider: true, generation: true },
      }))
      if (!connection) return yield* Effect.fail(new InvalidState({ code: "accounting_disconnected", message: "Accounting is disconnected" }))
      const scope = { organizationId: command.organizationId, consumerKey: `accounting:${connection.provider}:${connection.generation}` }
      const row = yield* Effect.promise(() => db.eventConsumerDelivery.findFirst({ where: { ...scope, id: input.deliveryId } }))
      if (!row) return yield* Effect.fail(new NotFound({ entity: "accounting_delivery", message: "Delivery not found" }))
      const reason = "reason" in input ? String(input.reason) : null
      const changed = yield* Effect.promise(() => db.eventConsumerDelivery.updateMany({
        where: { ...scope, id: row.id, status: "failed" },
        data: { status: action === "retry" ? "pending" : "skipped", availableAt: command.now,
          claimToken: null, leaseUntil: null, ...(action === "retry" ? { attempts: 0, error: Prisma.DbNull } : { error: { code: "admin_skipped", reason } }) },
      }))
      if (!changed.count) return yield* Effect.fail(new InvalidState({ code: "delivery_not_failed", message: "Only failed deliveries can be retried or skipped" }))
      if (action === "skip") yield* Effect.promise(() => advance(scope, db))
      command.emit({ aggregateType: "organization", aggregateId: command.organizationId,
        type: "accounting.action_recorded", payload: { action, provider: connection.provider, generation: connection.generation, deliveryId: row.id, reason } })
    }),
  })
}

export const retryAccountingDelivery = deliveryCommand("retry")
export const skipAccountingDelivery = deliveryCommand("skip")
