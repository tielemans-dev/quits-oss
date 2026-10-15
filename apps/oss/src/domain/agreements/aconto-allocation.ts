import { Effect } from "effect"
import { InvalidState } from "../errors"
import { Db } from "../services"

/**
 * Credit preparation and commit use the same guard under the agreement lock.
 * Keep it independent of billing/issuance: rendering also loads during outbox initialization.
 */
export const requireUnallocatedAconto = (invoiceId: string, items: ReadonlyArray<{ sourceKind?: string | null }>) => Effect.gen(function* () {
  const db = yield* Db
  const allocated = yield* Effect.promise(() => db.invoiceItem.count({ where: { sourceKind: "aconto", sourceRevision: invoiceId } }))
  if (allocated || items.some(line => line.sourceKind === "aconto"))
    return yield* new InvalidState({ code: "aconto_allocated", message: "Remove draft aconto deductions before crediting their source. Issued deductions require an allocation reversal." })
})
