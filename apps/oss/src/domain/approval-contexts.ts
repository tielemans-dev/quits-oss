import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { ApprovalContext } from "./command"
import { formatIsoDate } from "../lib/exports/format"
import { lockDocument } from "./documents/locks"
import { computeSettlement } from "./documents/settlement"
import { NotFound } from "./errors"
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

type Line = { description: string; quantity: { toString(): string }; lineGross: { toString(): string } }

/** The parts of an invoice or quote a customer receives. */
export function documentFingerprint(
  document: {
    number: string
    currency: string
    subtotalNet: { toString(): string }
    totalTax: { toString(): string }
    totalGross: { toString(): string }
    notes: string | null
    items: Line[]
  },
  recipient: string | null,
  dates: ReadonlyArray<Date | null>
) {
  return fingerprint([
    document.number,
    document.currency,
    document.subtotalNet.toString(),
    document.totalTax.toString(),
    document.totalGross.toString(),
    document.notes,
    document.items.map((item) => [item.description, item.quantity.toString(), item.lineGross.toString()]),
    recipient,
    dates.map((date) => date?.toISOString() ?? null),
  ])
}

const money = (amount: { toFixed(digits: number): string } | number, currency: string) =>
  `${typeof amount === "number" ? amount.toFixed(2) : amount.toFixed(2)} ${currency}`

/**
 * Locks a contact before its email address is read, so the recipient a person approved cannot
 * change before the command sends to it. Always lock the document first, then the contact.
 */
export const lockedContact = (contactId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* lockDocument("contact", contactId)
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

export const creditNoteIssueApproval = (input: {
  invoiceId: string
  reason: string
  mode: "full" | "lines" | "amount"
  amount?: number
}): Effect.Effect<ApprovalContext, NotFound, Db | Command> =>
  Effect.gen(function* () {
    const invoice = yield* loadInvoice(input.invoiceId)
    const scope =
      input.mode === "full"
        ? "everything still uncredited on"
        : input.mode === "amount" && input.amount !== undefined
          ? `${money(input.amount, invoice.currency)} of`
          : "selected lines of"
    return {
      summary: `Issue a credit note for ${scope} invoice ${invoice.number}: ${input.reason}`,
      version: fingerprint([invoice.totalGross.toString(), invoice.amountCredited.toString(), invoice.currency]),
      details: {
        number: invoice.number,
        customer: invoice.contact.name,
        total: invoice.totalGross.toFixed(2),
        currency: invoice.currency,
        amount: input.amount !== undefined ? input.amount.toFixed(2) : null,
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
      version: fingerprint([creditNote.number, creditNote.totalGross.toString(), recipient]),
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
      version: fingerprint([
        schedule.items,
        schedule.taxRate.toString(),
        schedule.currency,
        schedule.intervalCount,
        schedule.intervalUnit,
        schedule.autoSend,
        schedule.nextRunAt.toISOString(),
        schedule.contact.email,
      ]),
      details: {
        name: schedule.name,
        customer: schedule.contact.name,
        recipient: schedule.autoSend ? (schedule.contact.email ?? null) : null,
        cadence,
        nextRun: schedule.nextRunAt.toISOString().slice(0, 10),
        currency: schedule.currency,
      },
    }
  })
