import { Effect } from "effect"
import { creditNoteIssueInputSchema, creditNoteSendInputSchema } from "@quits/contracts/credit-notes"
import type { Prisma } from "../../../generated/prisma/client"
import { composeMessage } from "../../lib/email"
import { buildCreditNoteEmailContent } from "../../lib/emails/credit-note-email"
import { appLogger } from "../../lib/observability"
import type { AnyCommandDefinition } from "../command"
import { defineCommand } from "../command"
import { loadDocumentContext } from "../documents/context"
import { requireRecipientEmail, resolveInvoiceEmailContext } from "../documents/invoice-email"
import { allocateDocumentNumber, asIssued } from "../documents/numbering"
import { priceCreditNote } from "../documents/credit-pricing"
import { refreshInvoiceSettlement } from "../documents/settlement"
import { buildBuyerSnapshot, buildSellerSnapshot, withoutPaymentDetails } from "../documents/snapshots"
import { InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"
import { queueDocumentEmail, refuseWhileSending } from "../documents/document-delivery"
import { lockDocument } from "../documents/locks"
import { creditNoteIssueApproval, creditNoteSendApproval } from "../approval-contexts"

const creditNoteLogger = appLogger.child("credit-notes")

const num = (value: { toNumber(): number }) => value.toNumber()

/** Loads the invoice with a row lock so concurrent credit notes cannot over-credit it. */
const lockInvoiceForCredit = (invoiceId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command

    yield* lockDocument("invoice", invoiceId)
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
  approvalContext: (input) => creditNoteIssueApproval(input),
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command
      const invoice = yield* lockInvoiceForCredit(input.invoiceId)

      const built = yield* priceCreditNote(invoice, input)

      const { settings, sellerTaxIds } = yield* loadDocumentContext
      const number = command.issuance?.number ?? (yield* allocateDocumentNumber("creditNote"))

      const creditNote = yield* Effect.promise(() =>
        db.creditNote.create({
          data: {
            ...(command.issuance ? { id: command.issuance.documentId } : {}),
            organizationId,
            invoiceId: invoice.id,
            contactId: invoice.contactId,
            number,
            status: "issued",
            reason: input.reason,
            issueDate: command.issuance?.issuedAt ?? now,
            subtotalNet: built.subtotalNet,
            totalTax: built.totalTax,
            totalGross: built.totalGross,
            currency: invoice.currency,
            countryCode: invoice.countryCode,
            locale: invoice.locale,
            timezone: invoice.timezone,
            taxRegime: invoice.taxRegime,
            pricesIncludeTax: invoice.pricesIncludeTax,
            calculationVersion: invoice.calculationVersion,
            ...(built.creditedGroups ? {
              creditedGroups: built.creditedGroups as Prisma.InputJsonValue,
              payableRounding: built.payableRounding,
              vatEvidence: invoice.vatEvidence ?? undefined,
            } : {}),
            sellerSnapshot: (withoutPaymentDetails(invoice.sellerSnapshot) ??
              buildSellerSnapshot(settings, sellerTaxIds)) as Prisma.InputJsonValue,
            buyerSnapshot: (invoice.buyerSnapshot ??
              buildBuyerSnapshot(invoice.contact)) as Prisma.InputJsonValue,
            items: {
              create: built.lines.map(({ groupKey: _groupKey, ...line }, index) => ({ ...line, ...(command.issuance ? { id: `${command.issuance.documentId}:${index}` } : {}), sortOrder: index })),
            },
          },
          include: { items: { orderBy: { sortOrder: "asc" } } },
        })
      )

      const { settlement, previousStatus } = yield* refreshInvoiceSettlement(invoice.id)

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
  approvalContext: (input) => creditNoteSendApproval(input),
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId } = command

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

      yield* refuseWhileSending("creditNote", creditNote)
      const content = buildCreditNoteEmailContent({
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
        invoice: asIssued(creditNote.invoice),
        org: {
          companyName: settings.companyName,
          companyEmail: settings.companyEmail,
          locale: creditNote.locale,
          timezone: creditNote.timezone,
        },
        contactName: creditNote.contact.name,
      })
      // Recorded as sent once the provider accepts the queued email; see `delivery/outbox.ts`.
      const { document: updated, deliveryKey } = yield* queueDocumentEmail({
        kind: "creditNote",
        mode: "email",
        document: creditNote,
        recipient,
        message: composeMessage(recipient, content),
        idempotencyKey: `credit-note-send:${command.commandId}`,
        markSending: (data) => db.creditNote.update({ where: { id: creditNote.id }, data }),
      })
      creditNoteLogger.info("credit_note.email.queued", {
        organizationId,
        creditNoteId: creditNote.id,
        usingBrandedDomain: envelope.usingBrandedDomain,
      })
      return { ...updated, emailSent: false, emailPending: true, deliveryKey, recipient }
    }),
})

/** Owned by the credit notes feature. Credit notes are immutable once issued. */
export const creditNoteCommands: readonly AnyCommandDefinition[] = [issueCreditNote, sendCreditNote]
