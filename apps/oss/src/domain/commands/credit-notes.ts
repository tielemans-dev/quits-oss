import type { RenderInput } from "../documents/render-input"
import { Effect } from "effect"
import { lineAmounts, nominalLineTaxRate, priceBasis } from "../../lib/documents/line-amounts"
import { documentVatSummary } from "../documents/vat-summary"
import { creditNoteIssueInputSchema, creditNoteSendInputSchema, type CreditNoteIssueInput } from "@quits/contracts/credit-notes"
import { Prisma } from "../../../generated/prisma/client"
import { composeMessage } from "../../lib/email"
import { buildCreditNoteEmailContent } from "../../lib/emails/credit-note-email"
import { storedPdfAttachment } from "../../lib/documents/pdf-attachment"
import { appLogger } from "../../lib/observability"
import type { AnyCommandDefinition } from "../command"
import { defineCommand } from "../command"
import { requireRecipientEmail, resolveInvoiceEmailContext } from "../documents/invoice-email"
import { allocateDocumentNumber, asIssued } from "../documents/numbering"
import { priceCreditNote } from "../documents/credit-pricing"
import { computeSettlement, refreshInvoiceSettlement } from "../documents/settlement"
import { buildBuyerSnapshot, creditSellerSnapshot } from "../documents/snapshots"
import { loadDocumentContext } from "../documents/context"
import { InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"
import { queueDocumentEmail, refuseWhileSending } from "../documents/document-delivery"
import { lockArtifactOrganization } from "../documents/artifacts"
import { lockDocument } from "../documents/locks"
import { requireUnallocatedAconto } from "../agreements/aconto-allocation"
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
    yield* requireUnallocatedAconto(invoice.id, invoice.items)
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
  handle: (input) => saveCreditNote(input),
})

function saveCreditNote(input: CreditNoteIssueInput, draft = false) {
  return Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command
      if (draft) yield* Effect.promise(() => lockArtifactOrganization(db, organizationId))
      const invoice = yield* lockInvoiceForCredit(input.invoiceId)

      const built = yield* priceCreditNote(invoice, input)
      if (input.id) {
        yield* lockDocument("creditNote", input.id)
        const existing = yield* Effect.promise(() => db.creditNote.findFirst({ where: { id: input.id, organizationId, invoiceId: invoice.id, status: "draft" } }))
        if (!existing) return yield* new InvalidState({ code: "not_draft", message: "Credit note is no longer a draft" })
        if (!existing.totalGross.equals(built.totalGross) || !existing.totalTax.equals(built.totalTax) || !existing.subtotalNet.equals(built.subtotalNet))
          return yield* new InvalidState({ code: "credit_changed", message: "The remaining credit changed. Discard this draft and create a new one." })
      }
      if (!draft && new Prisma.Decimal(built.totalGross).greaterThan(computeSettlement(invoice).balanceDue)) {
        const funded = yield* Effect.promise(() => db.payment.count({ where: { invoiceId: invoice.id, receiptId: { not: null }, voidedAt: null } }))
        if (funded) return yield* new InvalidState({ code: "receipt_allocations_pending", message: "Reverse receipt allocations before crediting paid amounts, then refund or reallocate the released funds" })
      }

      const { settings, sellerTaxIds } = yield* loadDocumentContext
      const number = command.issuance?.number ?? (yield* allocateDocumentNumber("creditNote"))

      const data = {
            ...(command.issuance ? { id: command.issuance.documentId } : {}),
            organizationId,
            invoiceId: invoice.id,
            contactId: invoice.contactId,
            number,
            status: draft ? "draft" : "issued",
            draftSelection: draft ? input as Prisma.InputJsonValue : Prisma.DbNull,
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
            sellerSnapshot: creditSellerSnapshot(invoice.sellerSnapshot, settings, sellerTaxIds) as Prisma.InputJsonValue,
            buyerSnapshot: (invoice.buyerSnapshot ??
              buildBuyerSnapshot(invoice.contact)) as Prisma.InputJsonValue,
            items: {
              create: built.lines.map(({ groupKey: _groupKey, ...line }, index) => ({ ...line, ...(command.issuance ? { id: `${command.issuance.documentId}:${index}` } : {}), sortOrder: index })),
            },
      }
      const creditNote = yield* Effect.promise(() => input.id
        ? db.creditNote.update({ where: { id: input.id }, data: { ...data, items: { deleteMany: {}, ...data.items } }, include: { items: { orderBy: { sortOrder: "asc" } } } })
        : db.creditNote.create({ data, include: { items: { orderBy: { sortOrder: "asc" } } } }))
      if (draft) return creditNote

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
    })
}

export const createCreditNoteDraft = defineCommand({
  type: "credit_note.create_draft", permission: "creditNote:create", outwardFacing: false,
  input: creditNoteIssueInputSchema.refine(input => !input.id),
  summarize: input => `Draft credit for invoice ${input.invoiceId}`,
  handle: input => saveCreditNote(input, true),
})

export const discardCreditNoteDraft = defineCommand({
  type: "credit_note.discard_draft", permission: "creditNote:create", outwardFacing: false,
  input: creditNoteSendInputSchema,
  summarize: input => `Discard credit note draft ${input.id}`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    yield* lockDocument("creditNote", input.id)
    const result = yield* Effect.promise(() => db.creditNote.updateMany({ where: { id: input.id, organizationId, status: "draft" }, data: { status: "cancelled" } }))
    if (!result.count) return yield* new InvalidState({ code: "not_draft", message: "Only a draft can be discarded" })
    return { id: input.id }
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

      if (creditNote.status !== "issued") return yield* new InvalidState({ code: "not_issued", message: "Issue the credit note before sending it" })
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
      const candidate = yield* Effect.promise(() => db.issuanceCandidate.findFirst({
        where: { organizationId, documentKind: "creditNote", documentId: creditNote.id, status: "published" },
        orderBy: { createdAt: "desc" }, select: { renderInput: true },
      }))
      const frozen = (candidate?.renderInput as Extract<RenderInput, { kind: "creditNote" }> | undefined)?.pdf?.creditNote
      const pdf = yield* Effect.promise(() => storedPdfAttachment({ ref: creditNote.artifactPdfRef, hash: creditNote.artifactPdfHash, number: creditNote.number,
        log: { organizationId, documentKind: "creditNote", documentId: creditNote.id } }))
      const content = buildCreditNoteEmailContent({
        fromName: envelope.fromName,
        fromEmail: envelope.fromEmail,
        replyTo: envelope.replyTo,
        creditNote: {
          number: creditNote.number,
          issueDate: creditNote.issueDate,
          reason: creditNote.reason,
          sellerSnapshot: creditNote.sellerSnapshot,
          buyerSnapshot: creditNote.buyerSnapshot,
          contact: creditNote.contact,
          taxRate: frozen?.taxRate ?? nominalLineTaxRate(creditNote.items.map(item => num(item.taxRate))),
          subtotal: num(creditNote.subtotalNet),
          taxAmount: num(creditNote.totalTax),
          total: num(creditNote.totalGross),
          currency: creditNote.currency,
          taxRegime: creditNote.taxRegime,
          priceBasis: priceBasis(creditNote.pricesIncludeTax),
          ...documentVatSummary(creditNote),
          items: creditNote.items.map((item) => {
            const shown = lineAmounts(priceBasis(creditNote.pricesIncludeTax), item)
            return {
              description: item.description,
              quantity: num(item.quantity),
              unitPrice: num(shown.unitPrice),
              total: num(shown.amount),
              taxRate: num(item.taxRate),
            }
          }),
        },
        invoice: asIssued(creditNote.invoice),
        org: {
          companyName: settings.companyName,
          companyEmail: settings.companyEmail,
          companyAddress: settings.companyAddress,
          locale: creditNote.locale,
          timezone: creditNote.timezone,
        },
        contactName: creditNote.contact.name,
        pdfAttached: Boolean(pdf),
      })
      // Recorded as sent once the provider accepts the queued email; see `delivery/outbox.ts`.
      const { document: updated, deliveryKey } = yield* queueDocumentEmail({
        kind: "creditNote",
        mode: "email",
        document: creditNote,
        recipient,
        message: composeMessage(recipient, content, pdf),
        idempotencyKey: `credit-note-send:${command.commandId}`,
        markSending: (data) => db.creditNote.update({ where: { id: creditNote.id }, data }),
      })
      creditNoteLogger.info("credit_note.email.queued", {
        organizationId,
        creditNoteId: creditNote.id,
        usingBrandedDomain: envelope.usingBrandedDomain,
        pdfAttached: Boolean(pdf),
      })
      return { ...updated, emailSent: false, emailPending: true, deliveryKey, recipient }
    }),
})

/** Owned by the credit notes feature. Credit notes are immutable once issued. */
export const creditNoteCommands: readonly AnyCommandDefinition[] = [createCreditNoteDraft, discardCreditNoteDraft, issueCreditNote, sendCreditNote]
