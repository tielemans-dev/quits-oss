import { Effect } from "effect"
import { Prisma } from "../../../generated/prisma/client"
import { Command, Db } from "../services"

const lockableTables = {
  invoice: "invoice",
  quote: "quote",
  creditNote: "credit_note",
} as const

/**
 * Locks a document row for the rest of the command's transaction, so concurrent commands on the
 * same document (two sends, a send and a payment) run one after another instead of both acting
 * on the state they read first.
 */
export const lockDocument = (kind: keyof typeof lockableTables, id: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const table = Prisma.raw(`"${lockableTables[kind]}"`)
    yield* Effect.promise(
      () =>
        db.$queryRaw`SELECT "id" FROM ${table} WHERE "id" = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`
    )
  })
