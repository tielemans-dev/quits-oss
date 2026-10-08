import { Effect } from "effect"
import { InvalidState } from "../errors"
import { Command, Db } from "../services"

export type NumberedDocumentKind = "invoice" | "quote" | "creditNote" | "agreement"

const counters = {
  agreement: { prefix: "agreementPrefix", next: "agreementNextNum" },
  invoice: { prefix: "invoicePrefix", next: "invoiceNextNum" },
  quote: { prefix: "quotePrefix", next: "quoteNextNum" },
  creditNote: { prefix: "creditNotePrefix", next: "creditNoteNextNum" },
} as const

/** Mirrors the `OrgSettings` column defaults, for an organization whose settings row does not exist yet. */
const DEFAULT_PREFIX = { agreement: "AGR", invoice: "INV", quote: "QTE", creditNote: "CN" } as const

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

/**
 * The number the next issuance of this kind will receive, without taking it. Callers that need a
 * number before the issuing transaction (rendering an issued PDF) use it as a provisional value and
 * the transaction re-checks it under the organization lock. Never present it as reserved.
 */
export const peekNextDocumentNumber = (kind: NumberedDocumentKind) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const counter = counters[kind]
    const settings = yield* Effect.promise(() =>
      db.orgSettings.findUnique({
        where: { organizationId },
        select: { agreementPrefix: true, agreementNextNum: true, invoicePrefix: true, quotePrefix: true, creditNotePrefix: true, invoiceNextNum: true, quoteNextNum: true, creditNoteNextNum: true },
      })
    )
    // A missing settings row is created with the schema defaults the first time a number is taken.
    return formatDocumentNumber(settings?.[counter.prefix] ?? DEFAULT_PREFIX[kind], settings?.[counter.next] ?? 1)
  })

/** Names a document in a sentence: "invoice INV-0042", or "draft invoice" while it has no number. */
export function documentRef(noun: string, number: string | null) {
  return number ? `${noun} ${number}` : `draft ${noun}`
}

/**
 * Raised when the number a rendered issuance was prepared with is no longer the one the document
 * receives, because another document of the same kind was issued in between. The issuance is
 * prepared again with the new number; see `issueDocument`.
 */
export const NUMBER_CHANGED = "number_changed"

/**
 * The number a document takes when it is issued. Call it inside the issuing transaction, after the
 * organization lock: the allocation then cannot interleave with another issuance, and a failure
 * after this point rolls the allocation back with the rest of the transaction.
 *
 * A draft that already has a number (created before numbers moved to issuance, or one whose email
 * was refused after it took its number) keeps it. When the issuance was prepared before the
 * transaction, its rendered document carries a specific number; if the document would now receive
 * a different one, the preparation is stale and nothing is consumed.
 */
export const numberForIssuance = (kind: "invoice" | "quote", document: { number: string | null }) =>
  Effect.gen(function* () {
    const { issuance } = yield* Command
    const number = document.number ?? (yield* allocateDocumentNumber(kind))
    if (issuance && issuance.number !== number) {
      return yield* new InvalidState({
        code: NUMBER_CHANGED,
        message: "Another document was issued first, so this one now takes a different number. Try again.",
      })
    }
    return number
  })

/**
 * The number of a document that has been issued. Documents are numbered in the transaction that
 * issues them, so an issued document always has one; a missing number is a broken invariant.
 */
export function issuedNumber(document: { number: string | null }): string {
  if (document.number === null) throw new Error("An issued document has no number")
  return document.number
}

/** Narrows an issued document, whose number is always set, for code that prints or exports it. */
export function asIssued<T extends { number: string | null }>(document: T): T & { number: string } {
  return { ...document, number: issuedNumber(document) }
}
