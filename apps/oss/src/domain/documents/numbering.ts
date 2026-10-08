import { Effect } from "effect"
import { formatDocumentNumber } from "@quits/shared/documents"
import type { OrgSettings } from "../../../generated/prisma/client"
import { InvalidState } from "../errors"
import { Command, Db, type PendingEvent } from "../services"

export type NumberedDocumentKind = "invoice" | "quote" | "creditNote" | "agreement"

/** Where each kind keeps its prefix and counter in `OrgSettings`, and the prefix an organization without settings gets. */
const counters = {
  agreement: { prefix: "agreementPrefix", next: "agreementNextNum", defaultPrefix: "AGR" },
  invoice: { prefix: "invoicePrefix", next: "invoiceNextNum", defaultPrefix: "INV" },
  quote: { prefix: "quotePrefix", next: "quoteNextNum", defaultPrefix: "QTE" },
  creditNote: { prefix: "creditNotePrefix", next: "creditNoteNextNum", defaultPrefix: "CN" },
} as const

export const NUMBER_SETTINGS_SELECT = {
  agreementPrefix: true, agreementNextNum: true,
  invoicePrefix: true, invoiceNextNum: true,
  quotePrefix: true, quoteNextNum: true,
  creditNotePrefix: true, creditNoteNextNum: true,
} as const
export type NumberSettings = Pick<OrgSettings, keyof typeof NUMBER_SETTINGS_SELECT>

// Lives in shared so the client can format the number it previews.
export { formatDocumentNumber }

/**
 * The number the next document of this kind receives, read from the organization's settings.
 * `null` stands for an organization whose settings row does not exist yet: it is created with the
 * schema defaults the first time a number is taken, so the first number uses those defaults.
 */
export function nextNumberFromSettings(kind: NumberedDocumentKind, settings: NumberSettings | null) {
  const counter = counters[kind]
  return formatDocumentNumber(settings?.[counter.prefix] ?? counter.defaultPrefix, settings?.[counter.next] ?? 1)
}

/**
 * Allocates the next number atomically. The increment takes a row lock, so concurrent
 * issuances in one organization cannot receive the same number.
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
        select: NUMBER_SETTINGS_SELECT,
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
    const settings = yield* Effect.promise(() =>
      db.orgSettings.findUnique({ where: { organizationId }, select: NUMBER_SETTINGS_SELECT })
    )
    return nextNumberFromSettings(kind, settings)
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

export const DOCUMENT_NOT_ISSUED = "document_not_issued"

/**
 * The number of a document that has been issued. Documents are numbered in the transaction that
 * issues them, so an issued document always has one; a missing number is a broken invariant.
 * It is raised as a typed `InvalidState`, so callers outside a command (public pages, exports)
 * can tell it from a crash and explain it.
 */
export function issuedNumber(document: { number: string | null }): string {
  if (document.number === null) {
    throw new InvalidState({ code: DOCUMENT_NOT_ISSUED, message: "This document has not been issued, so it has no number" })
  }
  return document.number
}

export function isDocumentNotIssued(error: unknown): error is InvalidState {
  return error instanceof InvalidState && error.code === DOCUMENT_NOT_ISSUED
}

/**
 * Deleting a draft that already holds a number (an email that was refused after the number was
 * taken, or a draft numbered before numbers moved to issuance) leaves that number unused. The
 * sequence has a gap, so record it; the activity log explains it.
 */
export function numberVoidedByDraftDeletion(
  kind: "invoice" | "quote", documentId: string, number: string | null, organizationId: string
): PendingEvent[] {
  if (number === null) return []
  return [{
    aggregateType: "document", aggregateId: documentId, type: "document.number_voided",
    payload: { organizationId, documentKind: kind, number, reason: "draft_deleted" },
  }]
}

/** Narrows an issued document, whose number is always set, for code that prints or exports it. */
export function asIssued<T extends { number: string | null }>(document: T): T & { number: string } {
  return { ...document, number: issuedNumber(document) }
}
