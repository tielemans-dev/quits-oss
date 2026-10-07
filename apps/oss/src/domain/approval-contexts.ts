import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { CreditNoteIssueInput } from "@quits/contracts/credit-notes"
import type { ApprovalContext } from "./command"
import { formatIsoDate } from "../lib/exports/format"
import { lockDocument } from "./documents/locks"
import { priceCreditNote } from "./documents/credit-pricing"
import { computeSettlement } from "./documents/settlement"
import { NotFound, type DomainError } from "./errors"
import { Command, Db } from "./services"

/**
 * What a person approving an agent's command sees, and the version the command must still match
 * when it runs. A version fingerprints exactly the facts the person reviewed, so unrelated writes
 * (an overdue status change, an email-attempt marker) do not invalidate an approval while any
 * change to what will be sent, charged, or credited does.
 */
export function fingerprint(values: ReadonlyArray<unknown>) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32)
}

type Line = {
  description: string
  quantity: { toString(): string }
  unitPriceNet: { toString(): string }
  unitPriceGross: { toString(): string }
  taxRate: { toString(): string }
  lineGross: { toString(): string }
}

/**
 * The parts of an invoice or quote a customer receives: amounts, lines, dates, and who it is
 * addressed to (the contact, its name and company, and the buyer snapshot printed on the document).
 */
export function documentFingerprint(
  document: {
    number: string
    currency: string
    issueDate: Date
    subtotalNet: { toString(): string }
    totalTax: { toString(): string }
    totalGross: { toString(): string }
    notes: string | null
    contactId: string
    buyerSnapshot: unknown
    contact: { name: string; company?: string | null }
    items: Line[]
  },
  recipient: string | null,
  dates: ReadonlyArray<Date | null>
) {
  return fingerprint([
    document.number,
    document.currency,
    document.issueDate.toISOString(),
    document.subtotalNet.toString(),
    document.totalTax.toString(),
    document.totalGross.toString(),
    document.notes,
    document.items.map((item) => [
      item.description,
      item.quantity.toString(),
      item.unitPriceNet.toString(),
      item.unitPriceGross.toString(),
      item.taxRate.toString(),
      item.lineGross.toString(),
    ]),
    document.contactId,
    document.contact.name,
    document.contact.company ?? null,
    document.buyerSnapshot ?? null,
    recipient,
    dates.map((date) => date?.toISOString() ?? null),
  ])
}

const money = (amount: { toFixed(digits: number): string } | number, currency: string) =>
  `${typeof amount === "number" ? amount.toFixed(2) : amount.toFixed(2)} ${currency}`

/**
 * Locks a contact before its email address is read, so the recipient a person approved cannot
 * change before the command sends to it. Always lock the document first, then the contact.
 *
 * Takes FOR NO KEY UPDATE rather than FOR UPDATE: editing the contact's email (a non-key UPDATE)
 * still waits for this lock, but inserting a document that references the contact (which takes
 * FOR KEY SHARE on it) does not, so a concurrent draft insert cannot deadlock against an approval.
 */
export const lockedContact = (contactId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* lockDocument("contact", contactId, { strength: "no_key_update" })
    return yield* Effect.promise(() =>
      db.contact.findUniqueOrThrow({ where: { id: contactId }, select: { name: true, email: true } })
    )
  })

const loadInvoice = (invoiceId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    yield* lockDocument("invoice", invoiceId)
    const invoice = yield* Effect.promise(() =>
      db.invoice.findFirst({ where: { id: invoiceId, organizationId } })
    )
    if (!invoice) {
      return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: invoiceId })
    }
    return { ...invoice, contact: yield* lockedContact(invoice.contactId) }
  })

export const paymentRecordApproval = (input: {
  invoiceId: string
  amount: number
  method: string
  paidAt: string
}): Effect.Effect<ApprovalContext, NotFound, Db | Command> =>
  Effect.gen(function* () {
    const invoice = yield* loadInvoice(input.invoiceId)
    const { balanceDue } = computeSettlement(invoice)
    return {
      summary: `Record a ${money(input.amount, invoice.currency)} ${input.method.replaceAll("_", " ")} payment on invoice ${invoice.number}`,
      version: fingerprint([invoice.currency, invoice.totalGross.toString(), balanceDue.toString()]),
      details: {
        number: invoice.number,
        customer: invoice.contact.name,
        amount: input.amount.toFixed(2),
        currency: invoice.currency,
        balanceDue: balanceDue.toFixed(2),
        paidAt: input.paidAt,
        method: input.method,
      },
    }
  })

export const paymentVoidApproval = (input: {
  paymentId: string
  reason: string
}): Effect.Effect<ApprovalContext, NotFound, Db | Command> =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const [payment, settings] = yield* Effect.promise(() =>
      Promise.all([
        db.payment.findFirst({
          where: { id: input.paymentId, organizationId },
          include: { invoice: { select: { number: true, contact: { select: { name: true } } } } },
        }),
        db.orgSettings.findUnique({ where: { organizationId }, select: { timezone: true } }),
      ])
    )
    if (!payment) {
      return yield* new NotFound({ message: "Payment not found", entity: "payment", id: input.paymentId })
    }
    return {
      summary: `Void the ${money(payment.amount, payment.currency)} payment on invoice ${payment.invoice.number}`,
      version: fingerprint([payment.amount.toString(), payment.currency, payment.voidedAt?.toISOString() ?? null]),
      details: {
        number: payment.invoice.number,
        customer: payment.invoice.contact.name,
        amount: payment.amount.toFixed(2),
        currency: payment.currency,
        // Payment dates are calendar days in the organization's time zone.
        paidAt: formatIsoDate(payment.paidAt, settings?.timezone),
        reason: input.reason,
      },
    }
  })

/** At most this many credited lines are named in an approval summary; details list them all. */
const SUMMARY_LINES = 3

const quantityText = (quantity: number) => (Number.isInteger(quantity) ? `${quantity}` : quantity.toFixed(2))

export const creditNoteIssueApproval = (
  input: CreditNoteIssueInput
): Effect.Effect<ApprovalContext, DomainError, Db | Command> =>
  Effect.gen(function* () {
    const db = yield* Db
    const invoice = yield* loadInvoice(input.invoiceId)
    const [items, creditNotes] = yield* Effect.promise(() =>
      Promise.all([
        db.invoiceItem.findMany({ where: { invoiceId: invoice.id }, orderBy: { sortOrder: "asc" } }),
        db.creditNote.findMany({
          where: { invoiceId: invoice.id, status: "issued" },
          include: { items: true },
        }),
      ])
    )
    // Priced exactly as the issue command will price it, so the reviewer sees what is credited.
    const credit = yield* priceCreditNote({ ...invoice, items, creditNotes }, input)
    const amount = money(credit.totalGross, invoice.currency)
    const creditedLines = credit.lines.map((line) => `${quantityText(line.quantity)} × ${line.description}`)
    const named =
      creditedLines.length > SUMMARY_LINES
        ? `${creditedLines.slice(0, SUMMARY_LINES).join(", ")} and ${creditedLines.length - SUMMARY_LINES} more`
        : creditedLines.join(", ")
    const scope =
      input.mode === "full"
        ? `everything still uncredited on invoice ${invoice.number} (${amount})`
        : input.mode === "amount"
          ? `${amount} of invoice ${invoice.number}`
          : `${named} on invoice ${invoice.number} (${amount})`
    return {
      summary: `Issue a credit note for ${scope}: ${input.reason}`,
      version: fingerprint([
        invoice.totalGross.toString(),
        invoice.amountCredited.toString(),
        invoice.currency,
        credit.lines.map((line) => [line.invoiceItemId, line.description, line.quantity, line.lineGross]),
        credit.totalGross,
      ]),
      details: {
        number: invoice.number,
        customer: invoice.contact.name,
        total: invoice.totalGross.toFixed(2),
        currency: invoice.currency,
        amount: credit.totalGross.toFixed(2),
        lines: creditedLines.join("; "),
        reason: input.reason,
      },
    }
  })

export const creditNoteSendApproval = (input: {
  id: string
}): Effect.Effect<ApprovalContext, NotFound, Db | Command> =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    yield* lockDocument("creditNote", input.id)
    const row = yield* Effect.promise(() =>
      db.creditNote.findFirst({ where: { id: input.id, organizationId } })
    )
    if (!row) {
      return yield* new NotFound({ message: "Credit note not found", entity: "creditNote", id: input.id })
    }
    const creditNote = { ...row, contact: yield* lockedContact(row.contactId) }
    const recipient = creditNote.contact.email?.trim() || null
    return {
      summary: `Email credit note ${creditNote.number} (${money(creditNote.totalGross, creditNote.currency)}) to ${recipient ?? creditNote.contact.name}`,
      version: fingerprint([
        creditNote.number,
        creditNote.totalGross.toString(),
        creditNote.contactId,
        creditNote.contact.name,
        recipient,
      ]),
      details: {
        number: creditNote.number,
        customer: creditNote.contact.name,
        recipient,
        total: creditNote.totalGross.toFixed(2),
        currency: creditNote.currency,
      },
    }
  })

export const reminderSendApproval = (input: {
  invoiceId: string
}): Effect.Effect<ApprovalContext, NotFound, Db | Command> =>
  Effect.gen(function* () {
    const invoice = yield* loadInvoice(input.invoiceId)
    const recipient = invoice.contact.email?.trim() || null
    const { balanceDue } = computeSettlement(invoice)
    return {
      summary: `Send a payment reminder for invoice ${invoice.number} (${money(balanceDue, invoice.currency)} due) to ${recipient ?? invoice.contact.name}`,
      version: fingerprint([invoice.number, balanceDue.toString(), invoice.dueDate.toISOString(), recipient]),
      details: {
        number: invoice.number,
        customer: invoice.contact.name,
        recipient,
        balanceDue: balanceDue.toFixed(2),
        currency: invoice.currency,
        dueDate: invoice.dueDate.toISOString().slice(0, 10),
      },
    }
  })

export const recurringApproval = (
  input: { id: string },
  action: "resume" | "run_now"
): Effect.Effect<ApprovalContext, NotFound, Db | Command> =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    yield* lockDocument("recurringInvoice", input.id)
    const row = yield* Effect.promise(() =>
      db.recurringInvoice.findFirst({ where: { id: input.id, organizationId } })
    )
    if (!row) {
      return yield* new NotFound({ message: "Recurring invoice not found", entity: "recurringInvoice", id: input.id })
    }
    const schedule = { ...row, contact: yield* lockedContact(row.contactId) }
    const cadence = `every ${schedule.intervalCount} ${schedule.intervalUnit}${schedule.intervalCount === 1 ? "" : "s"}`
    const delivery = schedule.autoSend ? `sent to ${schedule.contact.email ?? schedule.contact.name}` : "kept as drafts"
    return {
      summary:
        action === "resume"
          ? `Resume "${schedule.name}" for ${schedule.contact.name}: invoices ${cadence}, ${delivery}`
          : `Generate the next "${schedule.name}" invoice for ${schedule.contact.name} now (${delivery})`,
      // Every field that shapes a generated invoice or its delivery. Bookkeeping (status, lastRunAt,
      // updatedAt) is left out so a scheduler tick on another schedule does not invalidate this.
      version: fingerprint([
        schedule.name,
        schedule.contactId,
        schedule.contact.name,
        schedule.contact.email,
        schedule.items,
        schedule.taxRate.toString(),
        schedule.currency,
        schedule.intervalCount,
        schedule.intervalUnit,
        schedule.startDate.toISOString(),
        schedule.nextRunAt.toISOString(),
        schedule.endsAt?.toISOString() ?? null,
        schedule.remainingRuns,
        schedule.dueInDays,
        schedule.notes,
        schedule.autoSend,
      ]),
      details: {
        name: schedule.name,
        customer: schedule.contact.name,
        recipient: schedule.autoSend ? (schedule.contact.email ?? null) : null,
        cadence,
        nextRun: schedule.nextRunAt.toISOString().slice(0, 10),
        endsAt: schedule.endsAt ? schedule.endsAt.toISOString().slice(0, 10) : null,
        remainingRuns: schedule.remainingRuns,
        paymentTerms: `Due in ${schedule.dueInDays} day${schedule.dueInDays === 1 ? "" : "s"}`,
        notes: schedule.notes,
        currency: schedule.currency,
      },
    }
  })
