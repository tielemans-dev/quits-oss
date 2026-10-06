import { Effect } from "effect"
import type { ApprovalContext } from "./command"
import { lockDocument } from "./documents/locks"
import { computeSettlement } from "./documents/settlement"
import { NotFound } from "./errors"
import { Command, Db } from "./services"

/**
 * What a person approving an agent's command sees, and the version the command must still match
 * when it runs. Versions combine the row's `updatedAt` with any related value that can change
 * without touching it (such as the contact's email address).
 */

const money = (amount: { toFixed(digits: number): string } | number, currency: string) =>
  `${typeof amount === "number" ? amount.toFixed(2) : amount.toFixed(2)} ${currency}`

const loadInvoice = (invoiceId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    yield* lockDocument("invoice", invoiceId)
    const invoice = yield* Effect.promise(() =>
      db.invoice.findFirst({
        where: { id: invoiceId, organizationId },
        include: { contact: { select: { name: true, email: true } } },
      })
    )
    if (!invoice) {
      return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: invoiceId })
    }
    return invoice
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
      version: invoice.updatedAt.toISOString(),
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
    const payment = yield* Effect.promise(() =>
      db.payment.findFirst({
        where: { id: input.paymentId, organizationId },
        include: { invoice: { select: { number: true, contact: { select: { name: true } } } } },
      })
    )
    if (!payment) {
      return yield* new NotFound({ message: "Payment not found", entity: "payment", id: input.paymentId })
    }
    return {
      summary: `Void the ${money(payment.amount, payment.currency)} payment on invoice ${payment.invoice.number}`,
      version: payment.updatedAt.toISOString(),
      details: {
        number: payment.invoice.number,
        customer: payment.invoice.contact.name,
        amount: payment.amount.toFixed(2),
        currency: payment.currency,
        paidAt: payment.paidAt.toISOString().slice(0, 10),
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
      version: invoice.updatedAt.toISOString(),
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
    const creditNote = yield* Effect.promise(() =>
      db.creditNote.findFirst({
        where: { id: input.id, organizationId },
        include: { contact: { select: { name: true, email: true } } },
      })
    )
    if (!creditNote) {
      return yield* new NotFound({ message: "Credit note not found", entity: "creditNote", id: input.id })
    }
    const recipient = creditNote.contact.email?.trim() || null
    return {
      summary: `Email credit note ${creditNote.number} (${money(creditNote.totalGross, creditNote.currency)}) to ${recipient ?? creditNote.contact.name}`,
      version: `${creditNote.updatedAt.toISOString()}|${recipient ?? ""}`,
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
      version: `${invoice.updatedAt.toISOString()}|${recipient ?? ""}`,
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
    const schedule = yield* Effect.promise(() =>
      db.recurringInvoice.findFirst({
        where: { id: input.id, organizationId },
        include: { contact: { select: { name: true, email: true } } },
      })
    )
    if (!schedule) {
      return yield* new NotFound({ message: "Recurring invoice not found", entity: "recurringInvoice", id: input.id })
    }
    const cadence = `every ${schedule.intervalCount} ${schedule.intervalUnit}${schedule.intervalCount === 1 ? "" : "s"}`
    const delivery = schedule.autoSend ? `sent to ${schedule.contact.email ?? schedule.contact.name}` : "kept as drafts"
    return {
      summary:
        action === "resume"
          ? `Resume "${schedule.name}" for ${schedule.contact.name}: invoices ${cadence}, ${delivery}`
          : `Generate the next "${schedule.name}" invoice for ${schedule.contact.name} now (${delivery})`,
      version: `${schedule.updatedAt.toISOString()}|${schedule.contact.email ?? ""}`,
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
