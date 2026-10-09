import { hasInvoiceBankTransfer } from "../../lib/payments/bank-transfer"
import type { RenderInput } from "../documents/render-input"
import { formatIsoDate } from "../../lib/exports/format"
import { invoiceDeliverableCommands } from "./invoices-from-deliverables"
import { updateLinkedInvoice } from "../agreements/linked-invoice"
import { releaseLines } from "../agreements/billing"
import { Effect } from "effect"
import {
  invoiceCreateDraftInputSchema,
  invoiceIdInputSchema,
  invoiceSendInputSchema,
  invoiceUpdateDraftInputSchema,
} from "@quits/contracts/invoices"
import type { z } from "zod"
import { billingProvider } from "../../lib/billing"
import { toNullableJsonInput } from "../../lib/prisma-json"
import { prisma } from "../../lib/db"
import { createEmailDeliveryAttempt } from "../../lib/email-delivery"
import { appLogger } from "../../lib/observability"
import { assertCloudOnboardingComplete } from "../../lib/onboarding/guard"
import { getPublicInvoicePaymentUrl } from "../../lib/payments/public"
import { defineCommand } from "../command"
import { assessCompliance, loadDocumentContext } from "../documents/context"
import {
  composeInvoiceEmail,
  requireRecipientEmail,
  resolveInvoiceEmailContext,
} from "../documents/invoice-email"
import { queueDocumentEmail, refuseWhileSending } from "../documents/document-delivery"
import { lockDocument } from "../documents/locks"
import { documentFingerprint, lockedContact } from "../approval-contexts"
import { asIssued, numberForIssuance, numberVoidedByDraftDeletion, documentRef } from "../documents/numbering"
import { requireDraftCurrency } from "../documents/currency"
import { impliedTaxRate, priceCurrentDraft, storedDraftItems } from "../documents/pricing"
import { buildBuyerSnapshot, buildSellerSnapshot, buyerContactSelect } from "../documents/snapshots"
import { requireVatIssuance } from "../documents/vat-issuance"
import { draftVatEvidenceSchema } from "@quits/contracts/vat"
import { InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"

const invoiceLogger = appLogger.child("invoices")

/** Runs a check that signals failure by throwing (onboarding, billing limits). */
function precondition(check: () => Promise<void>) {
  return Effect.tryPromise({
    try: check,
    catch: (error) =>
      new InvalidState({
        message: error instanceof Error ? error.message : "Precondition failed",
        code: "precondition_failed",
      }),
  })
}

const findContact = (contactId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const contact = yield* Effect.promise(() =>
      db.contact.findFirst({ where: { id: contactId, organizationId }, select: buyerContactSelect })
    )
    if (!contact) {
      return yield* new InvalidState({
        message: "Invalid contact for this organization",
        code: "invalid_contact",
      })
    }
    return contact
  })

const findInvoice = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const invoice = yield* Effect.promise(() =>
      db.invoice.findFirst({
        where: { id, organizationId },
        include: { contact: { include: { taxIds: true } }, items: { orderBy: { sortOrder: "asc" } } },
      })
    )
    if (!invoice) {
      return yield* new NotFound({ message: "Invoice not found", entity: "invoice", id })
    }
    return invoice
  })

/** Links a generated invoice to the recurring schedule run that produced it. */
export type InvoiceDraftOrigin = {
  recurringInvoiceId: string
  recurringRunDate: Date
}

/**
 * Creates a priced draft invoice and emits `invoice.draft_created`. Shared by the
 * `invoice.create_draft` command and recurring schedule runs.
 */
export const buildInvoiceDraft = (
  input: z.infer<typeof invoiceCreateDraftInputSchema>,
  origin?: InvoiceDraftOrigin
) =>
  Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    const { organizationId } = command

    yield* precondition(() => assertCloudOnboardingComplete(organizationId))
    const contact = yield* findContact(input.contactId)
    yield* precondition(() => billingProvider.assertInvoiceCreationAllowed(organizationId))

    const { settings, sellerTaxIds, profile } = yield* loadDocumentContext
    const currency = input.currency ?? settings.defaultCurrency ?? settings.currency
    yield* requireDraftCurrency(currency)
    const calculated = yield* priceCurrentDraft({
      items: input.items,
      vatEvidence: input.vatEvidence,
      taxRate: input.taxRate,
      pricesIncludeTax: settings.pricesIncludeTax,
      currency,
    })
    const compliance = assessCompliance(profile, sellerTaxIds, Number(input.taxRate))

    const invoice = yield* Effect.promise(() =>
      db.invoice.create({
        data: {
          organizationId,
          contactId: contact.id,
          // Drafts have no number: it is taken when the invoice is issued, so deleting a draft leaves no gap.
          status: "draft",
          dueDate: new Date(input.dueDate),
          supplyDate: new Date(input.supplyDate ?? formatIsoDate(command.now, settings.timezone)),
          subtotalNet: calculated.subtotalNet,
          totalTax: calculated.totalTax,
          totalGross: calculated.totalGross,
          calculationVersion: calculated.calculationVersion,
          vatEvidence: toNullableJsonInput(input.vatEvidence),
          currency,
          countryCode: settings.countryCode,
          locale: settings.locale,
          timezone: settings.timezone,
          taxRegime: settings.taxRegime,
          pricesIncludeTax: settings.pricesIncludeTax,
          sellerSnapshot: buildSellerSnapshot(settings, sellerTaxIds),
          buyerSnapshot: buildBuyerSnapshot(contact),
          complianceStatus: compliance.status,
          complianceErrors: compliance.issues,
          notes: input.notes,
          purchaseOrderRef: input.purchaseOrderRef,
          ...(origin
            ? {
                recurringInvoiceId: origin.recurringInvoiceId,
                recurringRunDate: origin.recurringRunDate,
              }
            : {}),
          items: { create: calculated.itemRows },
        },
        include: { items: { orderBy: { sortOrder: "asc" } } },
      })
    )

    // Keep the pinned v1 event payload numeric while persisting decimal strings.
    const priced = { totalGross: invoice.totalGross.toNumber() }
    command.emit({
      aggregateType: "invoice",
      aggregateId: invoice.id,
      type: "invoice.draft_created",
      payload: { number: invoice.number, contactId: contact.id, totalGross: priced.totalGross },
    })
    return invoice
  })

export const createInvoiceDraft = defineCommand({
  type: "invoice.create_draft",
  permission: "invoice:create",
  outwardFacing: false,
  input: invoiceCreateDraftInputSchema,
  summarize: (input) => `Create a draft invoice with ${input.items.length} line(s)`,
  handle: (input) => buildInvoiceDraft(input),
})

export const updateInvoiceDraft = defineCommand({
  type: "invoice.update_draft",
  permission: "invoice:update",
  outwardFacing: false,
  input: invoiceUpdateDraftInputSchema,
  summarize: (input) => `Update draft invoice ${input.id}`,
  handle: ({ expectedRevision, ...input }) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      yield* lockDocument("invoice", input.id)
      const existing = yield* findInvoice(input.id)

      if (existing.status !== "draft") {
        return yield* new InvalidState({
          message: "Only draft invoices can be edited",
          code: "not_draft",
        })
      }
      if (expectedRevision !== undefined && expectedRevision !== existing.editRevision) {
        return yield* new InvalidState({ code: "stale_draft", message: "This draft changed since it was loaded. Reload it before saving." })
      }
      if (existing.lastEmailAttemptOutcome === "sending") {
        return yield* new InvalidState({
          message: "This invoice is being emailed. Wait for that delivery to finish before changing it.",
          code: "send_in_progress",
        })
      }

      if (existing.agreementId) return yield* updateLinkedInvoice(existing, input)
      if (input.items?.some(item => item.deliverableId)) return yield* new InvalidState({ code: "invalid_linked_item", message: "Use invoice.createFromDeliverables to reserve work" })

      const data: Parameters<typeof db.invoice.update>[0]["data"] = { editRevision: { increment: 1 } }

      if (input.contactId) {
        const contact = yield* findContact(input.contactId)
        data.contact = { connect: { id: contact.id } }
        data.buyerSnapshot = buildBuyerSnapshot(contact)
      }
      if (input.dueDate) data.dueDate = new Date(input.dueDate)
      if (input.supplyDate) data.supplyDate = new Date(input.supplyDate)
      if (input.currency) data.currency = input.currency
      if (input.notes !== undefined) data.notes = input.notes
      if (input.purchaseOrderRef !== undefined) data.purchaseOrderRef = input.purchaseOrderRef

      // Every draft edit upgrades to the current calculator, including notes-only edits.
      const currency = input.currency ?? existing.currency
      yield* requireDraftCurrency(currency)
      const items = input.items ?? storedDraftItems(existing)
      // An explicitly supplied document rate fills all lines. Omitted rate retains per-line VAT.
      const pricedItems = input.taxRate === undefined ? items : items.map((item) => ({ ...item, vat: undefined }))
      const storedEvidence = draftVatEvidenceSchema.safeParse(existing.vatEvidence ?? {})
      const evidence = input.vatEvidence ?? (storedEvidence.success ? storedEvidence.data : {})
      const priced = yield* priceCurrentDraft({
        items: input.items ?? pricedItems,
        taxRate: input.taxRate ?? impliedTaxRate(existing),
        pricesIncludeTax: existing.pricesIncludeTax,
        currency,
        vatEvidence: evidence,
      })
      data.subtotalNet = priced.subtotalNet
      data.totalTax = priced.totalTax
      data.totalGross = priced.totalGross
      data.calculationVersion = priced.calculationVersion
      // Evidence does not select VAT treatment. Keep unreadable stored evidence (and its notice)
      // until the caller explicitly replaces it; pricing can proceed without it.
      if (input.vatEvidence !== undefined || storedEvidence.success) data.vatEvidence = toNullableJsonInput(evidence)
      yield* Effect.promise(() => db.invoiceItem.deleteMany({ where: { invoiceId: existing.id } }))
      data.items = { create: priced.itemRows }

      const invoice = yield* Effect.promise(() =>
        db.invoice.update({
          where: { id: existing.id },
          data,
          include: { contact: { include: { taxIds: true } }, items: { orderBy: { sortOrder: "asc" } } },
        })
      )

      command.emit({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "invoice.draft_updated",
        payload: { fields: Object.keys(input).filter((key) => key !== "id") },
      })
      return invoice
    }),
})

export const deleteInvoiceDraft = defineCommand({
  type: "invoice.delete_draft",
  permission: "invoice:delete",
  outwardFacing: false,
  input: invoiceIdInputSchema,
  summarize: (input) => `Delete draft invoice ${input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      yield* lockDocument("invoice", input.id)
      const invoice = yield* findInvoice(input.id)
      if (invoice.status !== "draft") {
        return yield* new InvalidState({
          message: "Only draft invoices can be deleted",
          code: "not_draft",
        })
      }
      if (invoice.lastEmailAttemptOutcome === "sending") {
        return yield* new InvalidState({
          message: "This invoice is being emailed. Wait for that delivery to finish before changing it.",
          code: "send_in_progress",
        })
      }

      if (invoice.agreementId) yield* releaseLines(invoice.agreementId, invoice.id, invoice.items)
      yield* Effect.promise(() => db.invoiceReminder.deleteMany({ where: { invoiceId: invoice.id } }))
      yield* Effect.promise(() => db.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } }))
      yield* Effect.promise(() => db.invoice.delete({ where: { id: invoice.id } }))
      command.emit({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "invoice.draft_deleted",
        payload: { number: invoice.number },
      })
      for (const event of numberVoidedByDraftDeletion("invoice", invoice.id, invoice.number, command.organizationId)) command.emit(event)
      return { id: invoice.id }
    }),
})

/** What a person approving an agent's invoice email sees, versioned by the invoice's last change. */
const invoiceEmailApprovalContext = (id: string, action: "send" | "resend", acknowledgeDisputed = false, valuationInput?: z.infer<typeof invoiceSendInputSchema>) =>
  Effect.gen(function* () {
    yield* lockDocument("invoice", id)
    const found = yield* findInvoice(id)
    if (action === "send" && found.purpose === "prepayment") return yield* new InvalidState({ code: "purpose_issuance_not_supported", message: "Prepayment issuance is not supported yet" })
    // Lock the contact before reading the address, so the approved recipient cannot change.
    const invoice = { ...found, contact: { ...found.contact, ...(yield* lockedContact(found.contactId)) } }
    const recipient = invoice.contact.email?.trim() || null
    const { settings, sellerTaxIds } = yield* loadDocumentContext
    const total = `${invoice.totalGross.toFixed(2)} ${invoice.currency}`
    return {
      summary:
        action === "send"
          ? `Send ${documentRef("invoice", invoice.number)} (${total}) to ${recipient ?? invoice.contact.name}`
          : `Email ${documentRef("invoice", invoice.number)} (${total}) to ${recipient ?? invoice.contact.name} again`,
      version: `${documentFingerprint({ ...invoice, buyerSnapshot: buildBuyerSnapshot(invoice.contact), sellerSnapshot: { ...invoice.sellerSnapshot as object, taxIds: sellerTaxIds, baseCurrency: settings.baseCurrency, valuationInput } }, recipient, [invoice.dueDate, invoice.supplyDate])}:${invoice.disputedRevision}`,
      details: {
        disputed: String(invoice.disputed),
        acknowledgeDisputed: String(acknowledgeDisputed),
        number: invoice.number,
        purchaseOrderRef: invoice.purchaseOrderRef,
        customer: invoice.contact.name,
        recipient,
        total: invoice.totalGross.toFixed(2),
        currency: invoice.currency,
        dueDate: invoice.dueDate.toISOString().slice(0, 10),
        supplyDate: valuationInput?.supplyDate ?? invoice.supplyDate?.toISOString().slice(0, 10) ?? null,
        baseCurrency: settings.baseCurrency,
        exchangeRate: valuationInput?.exchangeRate ?? (invoice.currency === settings.baseCurrency ? "1" : null),
        rateDate: valuationInput?.rateDate ?? null,
      },
    }
  })

/** Delivery is attempted right after the command commits; `emailPending` is true until then. */
export type InvoiceSendResult = Awaited<ReturnType<typeof prisma.invoice.update>> & {
  emailSent: boolean
  emailPending: boolean
  emailSkipReason?: string
  /** Identifies the queued delivery, whose outcome `readDeliveryResult` reports. */
  deliveryKey?: string
}

export const sendInvoice = defineCommand({
  type: "invoice.send",
  permission: "invoice:send",
  outwardFacing: true,
  input: invoiceSendInputSchema,
  summarize: (input) => `Send invoice ${input.id} to the customer`,
  approvalContext: (input) => invoiceEmailApprovalContext(input.id, "send", input.acknowledgeDisputed, input),
  // The invoice is marked as being sent and the rendered email is queued in the outbox; the
  // invoice becomes sent only once the provider accepts the email. See `delivery/outbox.ts`.
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command
      yield* lockDocument("invoice", input.id)
      const found = yield* findInvoice(input.id)

      if (found.status !== "draft") {
        return yield* new InvalidState({ message: "Only draft invoices can be sent", code: "not_draft" })
      }
      yield* refuseWhileSending("invoice", found)
      // The number is taken here, in the issuing transaction: if any later check fails, the
      // transaction rolls back and the number goes back with it.
      const invoice = { ...found, number: yield* numberForIssuance("invoice", found) }
      if (invoice.disputed && !input.acknowledgeDisputed)
        return yield* new InvalidState({ code: "disputed_deliverables", message: "The customer requested changes. Explicitly acknowledge the disputed draft before sending." })
      if (invoice.disputed) command.emit({
        aggregateType: "invoice", aggregateId: invoice.id, type: "invoice.dispute_acknowledged",
        payload: { number: invoice.number, disputedRevision: invoice.disputedRevision, acknowledgeDisputed: true },
      })
      if (invoice.purpose === "prepayment") return yield* new InvalidState({ code: "purpose_issuance_not_supported", message: "Prepayment issuance is not supported yet. You can explicitly invoice the schedule as a sale instead." })
      if (invoice.agreementId && !command.issuance) return yield* new InvalidState({ code: "issuance_required", message: "Linked invoices must issue through issueDocument" })
      yield* requireVatIssuance({ ...invoice, buyerSnapshot: buildBuyerSnapshot(invoice.contact) })

      const { settings, sellerTaxIds, profile } = yield* loadDocumentContext
      const emailContext = resolveInvoiceEmailContext(settings)
      const compliance = assessCompliance(profile, sellerTaxIds, impliedTaxRate(invoice))
      if (compliance.blocking.length > 0) {
        return yield* new InvalidState({
          message: `Compliance check failed: ${compliance.blocking.map((issue) => issue.code).join(", ")}`,
          code: "compliance_failed",
        })
      }
      // The candidate contains the account frozen for this issuance. The draft snapshot predates it.
      const candidate = command.issuance
        ? yield* Effect.promise(() => db.issuanceCandidate.findUniqueOrThrow({ where: { id: command.issuance!.candidateId } }))
        : null
      const frozenInput = candidate?.renderInput as unknown as RenderInput | undefined
      const bankTransfer = frozenInput?.kind === "invoice"
        ? hasInvoiceBankTransfer({ bankAccount: frozenInput.pdf.invoice.bankAccount })
        : false
      const paymentLinkAvailable = emailContext.stripeConfigured || bankTransfer
      const recipient = yield* requireRecipientEmail(invoice.contact)

      if (!emailContext.emailDelivery.available) {
        if (!input.allowSendWithoutEmail) {
          return yield* new InvalidState({
            message: "Email delivery is not configured",
            code: "email_unavailable",
          })
        }
        const emailSkipReason = "Email delivery is not configured"
        invoiceLogger.warn("invoice.email.skipped", { organizationId, invoiceId: invoice.id, reason: "provider_missing" })
        const updated = yield* Effect.promise(() =>
          db.invoice.update({
            where: { id: invoice.id },
            data: {
              number: invoice.number,
              status: "sent",
              issueDate: command.issuance?.issuedAt ?? now,
              publicPaymentIssuedAt: paymentLinkAvailable ? (invoice.publicPaymentIssuedAt ?? now) : null,
              ...createEmailDeliveryAttempt({
                at: now,
                outcome: "skipped",
                code: "provider_missing",
                message: emailSkipReason,
              }),
            },
          })
        )
        command.emit({
          aggregateType: "invoice",
          aggregateId: invoice.id,
          type: "invoice.sent",
          payload: { number: invoice.number, emailSent: false, recipient },
        })
        const result: InvoiceSendResult = { ...updated, emailSent: false, emailPending: false, emailSkipReason }
        return result
      }

      // The email carries the issue date and pay link the invoice will have once it is sent.
      const publicPaymentIssuedAt = paymentLinkAvailable ? (invoice.publicPaymentIssuedAt ?? now) : null
      const publicPaymentUrl = publicPaymentIssuedAt
        ? getPublicInvoicePaymentUrl({
            id: invoice.id,
            status: "sent",
            paymentStatus: invoice.paymentStatus,
            publicPaymentIssuedAt,
            publicPaymentKeyVersion: invoice.publicPaymentKeyVersion,
          })
        : null
      const email = composeInvoiceEmail({
        invoice: { ...invoice, issueDate: command.issuance?.issuedAt ?? now },
        settings,
        to: recipient,
        publicPaymentUrl,
      })
      const { document: updated, deliveryKey } = yield* queueDocumentEmail({
        kind: "invoice",
        mode: "send",
        document: invoice,
        recipient,
        message: email.message,
        idempotencyKey: `invoice-send:${invoice.id}:${now.getTime()}`,
        publicLinkIssuedAt: publicPaymentIssuedAt,
        markSending: (data) => db.invoice.update({ where: { id: invoice.id }, data: { ...data, number: invoice.number } }),
      })
      invoiceLogger.info("invoice.email.queued", {
        organizationId,
        invoiceId: invoice.id,
        usingBrandedDomain: email.usingBrandedDomain,
        hasPublicPaymentUrl: Boolean(publicPaymentUrl),
      })
      const result: InvoiceSendResult = { ...updated, emailSent: false, emailPending: true, deliveryKey }
      return result
    }),
})

export const resendInvoiceEmail = defineCommand({
  type: "invoice.resend_email",
  permission: "invoice:send",
  outwardFacing: true,
  input: invoiceIdInputSchema,
  summarize: (input) => `Email invoice ${input.id} to the customer again`,
  approvalContext: (input) => invoiceEmailApprovalContext(input.id, "resend"),
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      yield* lockDocument("invoice", input.id)
      const invoice = yield* findInvoice(input.id)

      if (!["sent", "overdue"].includes(invoice.status)) {
        return yield* new InvalidState({
          message: "Only sent or overdue invoices can be resent by email",
          code: "not_sent",
        })
      }
      yield* refuseWhileSending("invoice", invoice)

      const { settings } = yield* loadDocumentContext
      const emailContext = resolveInvoiceEmailContext(settings)
      const publicPaymentUrl =
        (emailContext.stripeConfigured || hasInvoiceBankTransfer(invoice.sellerSnapshot)) && invoice.publicPaymentIssuedAt
          ? getPublicInvoicePaymentUrl(invoice)
          : null
      const recipient = yield* requireRecipientEmail(invoice.contact)
      if (!emailContext.emailDelivery.available) {
        return yield* new InvalidState({
          message: "Email delivery is not configured",
          code: "email_unavailable",
        })
      }

      const email = composeInvoiceEmail({ invoice: asIssued(invoice), settings, to: recipient, publicPaymentUrl })
      const { document: updated, deliveryKey } = yield* queueDocumentEmail({
        kind: "invoice",
        mode: "email",
        document: invoice,
        recipient,
        message: email.message,
        idempotencyKey: `invoice-resend:${command.commandId}`,
        markSending: (data) => db.invoice.update({ where: { id: invoice.id }, data }),
      })
      invoiceLogger.info("invoice.email.resend_queued", {
        organizationId: command.organizationId,
        invoiceId: invoice.id,
        usingBrandedDomain: email.usingBrandedDomain,
        hasPublicPaymentUrl: Boolean(publicPaymentUrl),
      })
      const result: InvoiceSendResult = { ...updated, emailSent: false, emailPending: true, deliveryKey }
      return result
    }),
})

export const invoiceCommands = [
  ...invoiceDeliverableCommands,
  createInvoiceDraft,
  updateInvoiceDraft,
  deleteInvoiceDraft,
  sendInvoice,
  resendInvoiceEmail,
] as const
