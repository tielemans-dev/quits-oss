import { Effect } from "effect"
import { creditNoteIssueInputSchema, creditNoteSendInputSchema } from "@yaip/contracts/credit-notes"
import type { Prisma } from "../../../generated/prisma/client"
import {
  buildCreditLines,
  computeCreditAvailability,
  type CreditableInvoiceLine,
} from "../../lib/credit-notes/calculation"
import { createEmailDeliveryAttempt } from "../../lib/email-delivery"
import { sendCreditNoteEmail } from "../../lib/emails/credit-note-email"
import { prisma } from "../../lib/db"
import { translate } from "../../lib/i18n/translate"
import { appLogger } from "../../lib/observability"
import type { AnyCommandDefinition } from "../command"
import { defineCommand } from "../command"
import { loadDocumentContext } from "../documents/context"
import { requireRecipientEmail, resolveInvoiceEmailContext } from "../documents/invoice-email"
import { allocateDocumentNumber } from "../documents/numbering"
import { impliedTaxRate } from "../documents/pricing"
import { refreshInvoiceSettlement } from "../documents/settlement"
import { buildBuyerSnapshot, buildSellerSnapshot } from "../documents/snapshots"
import { ExternalFailure, InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"
import { lockDocument } from "../documents/locks"

const creditNoteLogger = appLogger.child("credit-notes")

const num = (value: { toNumber(): number }) => value.toNumber()

/** Loads the invoice with a row lock so concurrent credit notes cannot over-credit it. */
const lockInvoiceForCredit = (invoiceId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command

    yield* Effect.promise(
      () => db.$queryRaw`SELECT id FROM "invoice" WHERE id = ${invoiceId} FOR UPDATE`
    )
    const invoice = yield* Effect.promise(() =>
      db.invoice.findFirst({
        where: { id: invoiceId, organizationId },
        include: {
          contact: true,
          items: { orderBy: { sortOrder: "asc" } },
          creditNotes: { where: { status: "issued" }, include: { items: true } },
        },
      })
    )
    if (!invoice) {
      return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id: invoiceId })
    }
    return invoice
  })

type Decimalish = { toNumber(): number }
type CreditLineAmounts = {
  quantity: Decimalish
  lineNet: Decimalish
  lineTax: Decimalish
  lineGross: Decimalish
}

/** What is still creditable on an invoice, given its lines and issued credit notes. */
export function creditAvailabilityFor(invoice: {
  subtotalNet: Decimalish
  totalTax: Decimalish
  totalGross: Decimalish
  items: Array<
    CreditLineAmounts & {
      id: string
      description: string
      unitPriceNet: Decimalish
      unitPriceGross: Decimalish
      taxRate: Decimalish
      taxCategory: string
      taxCode: string | null
    }
  >
  creditNotes: Array<{
    subtotalNet: Decimalish
    totalTax: Decimalish
    totalGross: Decimalish
    items: Array<CreditLineAmounts & { invoiceItemId: string | null }>
  }>
}) {
  const lines: CreditableInvoiceLine[] = invoice.items.map((item) => ({
    id: item.id,
    description: item.description,
    quantity: num(item.quantity),
    unitPriceNet: num(item.unitPriceNet),
    unitPriceGross: num(item.unitPriceGross),
    lineNet: num(item.lineNet),
    lineTax: num(item.lineTax),
    lineGross: num(item.lineGross),
    taxRate: num(item.taxRate),
    taxCategory: item.taxCategory,
    taxCode: item.taxCode,
  }))
  const priorCredits = invoice.creditNotes.flatMap((creditNote) =>
    creditNote.items.map((item) => ({
      invoiceItemId: item.invoiceItemId,
      quantity: num(item.quantity),
      lineNet: num(item.lineNet),
      lineTax: num(item.lineTax),
      lineGross: num(item.lineGross),
    }))
  )
  const credited = (pick: (creditNote: (typeof invoice.creditNotes)[number]) => Decimalish) =>
    invoice.creditNotes.reduce((total, creditNote) => total + Math.round(num(pick(creditNote)) * 100), 0) /
    100

  return computeCreditAvailability({
    lines,
    priorCredits,
    totalNet: num(invoice.subtotalNet),
    totalTax: num(invoice.totalTax),
    totalGross: num(invoice.totalGross),
    creditedNet: credited((creditNote) => creditNote.subtotalNet),
    creditedTax: credited((creditNote) => creditNote.totalTax),
    creditedGross: credited((creditNote) => creditNote.totalGross),
  })
}

/** The tax rate amount credits are priced at: the invoice's line rate, else its implied rate. */
export function creditTaxRate(invoice: {
  items: Array<{ taxRate: { toNumber(): number } }>
  subtotalNet: { toNumber(): number }
  totalTax: { toNumber(): number }
}) {
  const lineRate = invoice.items[0]?.taxRate.toNumber()
  return lineRate ?? Math.round(impliedTaxRate(invoice) * 100) / 100
}

export const issueCreditNote = defineCommand({
  type: "credit_note.issue",
  permission: "creditNote:create",
  outwardFacing: true,
  input: creditNoteIssueInputSchema,
  summarize: (input) =>
    input.mode === "full"
      ? `Fully credit invoice ${input.invoiceId}: ${input.reason}`
      : input.mode === "amount"
        ? `Credit ${input.amount} on invoice ${input.invoiceId}: ${input.reason}`
        : `Credit ${input.lines.length} line(s) of invoice ${input.invoiceId}: ${input.reason}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command
      const invoice = yield* lockInvoiceForCredit(input.invoiceId)

      if (invoice.status === "draft") {
        return yield* new InvalidState({
          message: "Only issued invoices can be credited",
          code: "invoice_not_issued",
        })
      }

      const built = buildCreditLines({
        availability: creditAvailabilityFor(invoice),
        selection: input,
        taxRate: creditTaxRate(invoice),
        amountDescription: translate("creditNotes.amountDescription", invoice.locale, {
          number: invoice.number,
        }),
      })
      if (!built.ok) {
        return yield* new InvalidState({ message: built.message, code: built.code })
      }

      const { settings, sellerTaxIds } = yield* loadDocumentContext
      const number = yield* allocateDocumentNumber("creditNote")

      const creditNote = yield* Effect.promise(() =>
        db.creditNote.create({
          data: {
            organizationId,
            invoiceId: invoice.id,
            contactId: invoice.contactId,
            number,
            status: "issued",
            reason: input.reason,
            issueDate: now,
            subtotalNet: built.subtotalNet,
            totalTax: built.totalTax,
            totalGross: built.totalGross,
            currency: invoice.currency,
            countryCode: invoice.countryCode,
            locale: invoice.locale,
            timezone: invoice.timezone,
            taxRegime: invoice.taxRegime,
            pricesIncludeTax: invoice.pricesIncludeTax,
            sellerSnapshot: (invoice.sellerSnapshot ??
              buildSellerSnapshot(settings, sellerTaxIds)) as Prisma.InputJsonValue,
            buyerSnapshot: (invoice.buyerSnapshot ??
              buildBuyerSnapshot(invoice.contact)) as Prisma.InputJsonValue,
            items: {
              create: built.lines.map((line, index) => ({ ...line, sortOrder: index })),
            },
          },
          include: { items: { orderBy: { sortOrder: "asc" } } },
        })
      )

      const { settlement, previousStatus } = yield* refreshInvoiceSettlement(invoice.id)

      command.emit({
        aggregateType: "credit_note",
        aggregateId: creditNote.id,
        type: "credit_note.issued",
        payload: {
          number,
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          mode: input.mode,
          reason: input.reason,
          totalGross: built.totalGross,
        },
      })
      if (settlement.fullyCredited && previousStatus !== "credited") {
        command.emit({
          aggregateType: "invoice",
          aggregateId: invoice.id,
          type: "invoice.credited",
          payload: { number: invoice.number, creditNoteId: creditNote.id, creditNoteNumber: number },
        })
      }

      return creditNote
    }),
})

export const sendCreditNote = defineCommand({
  type: "credit_note.send",
  permission: "creditNote:send",
  outwardFacing: true,
  input: creditNoteSendInputSchema,
  summarize: (input) => `Email credit note ${input.id} to the customer`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command

      yield* lockDocument("creditNote", input.id)
      const creditNote = yield* Effect.promise(() =>
        db.creditNote.findFirst({
          where: { id: input.id, organizationId },
          include: {
            contact: true,
            invoice: { select: { number: true, issueDate: true } },
            items: { orderBy: { sortOrder: "asc" } },
          },
        })
      )
      if (!creditNote) {
        return yield* new NotFound({ message: "Credit note not found", entity: "credit_note", id: input.id })
      }

      const { settings } = yield* loadDocumentContext
      const { envelope, emailDelivery } = resolveInvoiceEmailContext(settings)
      const recipient = yield* requireRecipientEmail(creditNote.contact)
      if (!emailDelivery.available) {
        return yield* new InvalidState({
          message: "Email delivery is not configured",
          code: "email_unavailable",
        })
      }

      yield* Effect.tryPromise({
        try: () =>
          sendCreditNoteEmail({
            to: recipient,
            fromName: envelope.fromName,
            fromEmail: envelope.fromEmail,
            replyTo: envelope.replyTo,
            creditNote: {
              number: creditNote.number,
              issueDate: creditNote.issueDate,
              reason: creditNote.reason,
              subtotal: num(creditNote.subtotalNet),
              taxAmount: num(creditNote.totalTax),
              total: num(creditNote.totalGross),
              currency: creditNote.currency,
              items: creditNote.items.map((item) => ({
                description: item.description,
                quantity: num(item.quantity),
                unitPrice: num(item.unitPriceGross),
                total: num(item.lineGross),
              })),
            },
            invoice: creditNote.invoice,
            org: {
              companyName: settings.companyName,
              companyEmail: settings.companyEmail,
              locale: creditNote.locale,
              timezone: creditNote.timezone,
            },
            contactName: creditNote.contact.name,
          }, { idempotencyScope: `credit-note-send:${command.commandId}` }),
        catch: (cause) => cause,
      }).pipe(
        // Recorded after the rollback so the failed attempt survives the command failing,
        // matching invoice sending.
        Effect.catchAll((cause) => {
          command.onRollback(() =>
            prisma.creditNote.update({
              where: { id: creditNote.id },
              data: createEmailDeliveryAttempt({
                at: now,
                outcome: "failed",
                code: "send_failed",
                message: "Failed to send credit note email.",
              }),
            })
          )
          return Effect.fail(
            new ExternalFailure({
              message: "Failed to send credit note email.",
              service: "email",
              cause,
            })
          )
        })
      )

      creditNoteLogger.info("credit_note.email.sent", {
        organizationId,
        creditNoteId: creditNote.id,
        usingBrandedDomain: envelope.usingBrandedDomain,
      })

      const updated = yield* Effect.promise(() =>
        db.creditNote.update({
          where: { id: creditNote.id },
          data: createEmailDeliveryAttempt({
            at: now,
            outcome: "sent",
            code: "sent",
            message: "Credit note email sent.",
          }),
        })
      )

      command.emit({
        aggregateType: "credit_note",
        aggregateId: creditNote.id,
        type: "credit_note.sent",
        payload: { number: creditNote.number, recipient },
      })
      return { ...updated, emailSent: true, recipient }
    }),
})

/** Owned by the credit notes feature. Credit notes are immutable once issued. */
export const creditNoteCommands: readonly AnyCommandDefinition[] = [issueCreditNote, sendCreditNote]
