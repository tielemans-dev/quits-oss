import { Effect } from "effect"
import { Command, Db } from "../services"

export type NumberedDocumentKind = "invoice" | "quote" | "creditNote" | "agreement"

const counters = {
  agreement: { prefix: "agreementPrefix", next: "agreementNextNum" },
  invoice: { prefix: "invoicePrefix", next: "invoiceNextNum" },
  quote: { prefix: "quotePrefix", next: "quoteNextNum" },
  creditNote: { prefix: "creditNotePrefix", next: "creditNoteNextNum" },
} as const

export function formatDocumentNumber(prefix: string, value: number) {
  return `${prefix}-${String(value).padStart(4, "0")}`
}

/**
 * Allocates the next number atomically. The increment takes a row lock, so concurrent
 * creates in one organization cannot receive the same number.
 */
export const allocateDocumentNumber = (kind: NumberedDocumentKind) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const counter = counters[kind]

    const settings = yield* Effect.promise(() =>
      db.orgSettings.upsert({
        where: { organizationId },
        create: { organizationId, [counter.next]: 2 },
        update: { [counter.next]: { increment: 1 } },
        select: { agreementPrefix: true, agreementNextNum: true, invoicePrefix: true, quotePrefix: true, creditNotePrefix: true, invoiceNextNum: true, quoteNextNum: true, creditNoteNextNum: true },
      })
    )

    return formatDocumentNumber(settings[counter.prefix], settings[counter.next] - 1)
  })
