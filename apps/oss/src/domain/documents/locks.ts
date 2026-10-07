import { Effect } from "effect"
import { Prisma } from "../../../generated/prisma/client"
import { Command, Db } from "../services"

const lockableTables = {
  agreement: "agreement",
  invoice: "invoice",
  quote: "quote",
  creditNote: "credit_note",
  contact: "contact",
  recurringInvoice: "recurring_invoice",
} as const

/**
 * Locks a document row for the rest of the command's transaction, so concurrent commands on the
 * same document (two sends, a send and a payment, a schedule edit and a scheduled run) run one
 * after another instead of both acting on the state they read first. Lock before reading the
 * row: a read taken before the lock may already be stale.
 *
 * `no_key_update` (FOR NO KEY UPDATE) still excludes concurrent edits of the row but lets other
 * transactions insert rows that reference it (foreign keys take FOR KEY SHARE). Use it for rows
 * that are referenced by documents created concurrently, such as contacts.
 */
export const lockDocument = (
  kind: keyof typeof lockableTables,
  id: string,
  options: { strength?: "update" | "no_key_update" } = {}
) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    // Discover the immutable parent before locking any invoice. All callers, including
    // approval reads and artifact binding, therefore use agreement -> invoice order.
    if (kind === "invoice") {
      const invoice = yield* Effect.promise(() => db.invoice.findFirst({ where: { id, organizationId }, select: { agreementId: true } }))
      if (invoice?.agreementId) {
        yield* Effect.promise(() => db.$queryRaw`SELECT "id" FROM "agreement" WHERE "id" = ${invoice.agreementId} AND "organizationId" = ${organizationId} FOR UPDATE`)
      }
    }
    const table = Prisma.raw(`"${lockableTables[kind]}"`)
    const strength = Prisma.raw(options.strength === "no_key_update" ? "FOR NO KEY UPDATE" : "FOR UPDATE")
    yield* Effect.promise(
      () =>
        db.$queryRaw`SELECT "id" FROM ${table} WHERE "id" = ${id} AND "organizationId" = ${organizationId} ${strength}`
    )
  })

/** Delivery completions have no Command service, but take the same parent-first locks. */
export async function lockInvoiceForCompletion(db: Prisma.TransactionClient, id: string, organizationId: string) {
  const invoice = await db.invoice.findFirst({ where: { id, organizationId }, select: { agreementId: true } })
  if (invoice?.agreementId) await db.$queryRaw`SELECT "id" FROM "agreement" WHERE "id" = ${invoice.agreementId} AND "organizationId" = ${organizationId} FOR UPDATE`
  await db.$queryRaw`SELECT "id" FROM "invoice" WHERE "id" = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`
}
