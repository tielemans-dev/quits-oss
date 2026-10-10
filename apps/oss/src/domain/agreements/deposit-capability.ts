import { Effect } from "effect"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { Db } from "../services"
import { InvalidState } from "../errors"

/** Applies to new deposit operations, never to stored snapshots or payment/document access. */
export function requireDepositsEnabled(lines: ReadonlyArray<{ isDeposit?: boolean }>) {
  return Effect.suspend(() =>
    lines.some(line => line.isDeposit) && !getRuntimeCapabilities().agreements.depositsEnabled
      ? Effect.fail(new InvalidState({
          code: "deposits_disabled",
          message: "Deposits and advance-payment schedules are disabled in this runtime",
        }))
      : Effect.void,
  )
}

/** Refuses issuance of drafts prepared before the runtime disabled deposits. */
export function requireDepositInvoiceEnabled(invoice: {
  purpose: string
  scheduleSaleChoice: unknown
  items: ReadonlyArray<{ deliverableId: string | null }>
}) {
  return Effect.gen(function* () {
    if (getRuntimeCapabilities().agreements.depositsEnabled) return
    yield* requireDepositsEnabled([{ isDeposit: invoice.purpose === "prepayment" || invoice.scheduleSaleChoice != null }])
    const ids = invoice.items.flatMap(line => line.deliverableId ? [line.deliverableId] : [])
    if (!ids.length) return
    const db = yield* Db
    const deposit = yield* Effect.promise(() => db.deliverable.findFirst({
      where: { id: { in: ids }, isDeposit: true }, select: { isDeposit: true },
    }))
    yield* requireDepositsEnabled(deposit ? [deposit] : [])
  })
}
