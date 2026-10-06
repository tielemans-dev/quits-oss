import { Effect } from "effect"
import {
  invoiceCreateDraftInputSchema,
  invoiceIdInputSchema,
  invoiceSendInputSchema,
  invoiceUpdateDraftInputSchema,
} from "@yaip/contracts/invoices"
import type { z } from "zod"
import { billingProvider } from "../../lib/billing"
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
import { allocateDocumentNumber } from "../documents/numbering"
import { impliedTaxRate, priceDocument } from "../documents/pricing"
import { buildBuyerSnapshot, buildSellerSnapshot, buyerContactSelect } from "../documents/snapshots"
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
        include: { contact: true, items: { orderBy: { sortOrder: "asc" } } },
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
    const number = yield* allocateDocumentNumber("invoice")
    const currency = input.currency ?? settings.defaultCurrency ?? settings.currency
    const priced = priceDocument({
      profile,
      items: input.items,
      taxRate: input.taxRate,
      pricesIncludeTax: settings.pricesIncludeTax,
      currency,
    })
    const compliance = assessCompliance(profile, sellerTaxIds, input.taxRate)

    const invoice = yield* Effect.promise(() =>
      db.invoice.create({
        data: {
          organizationId,
          contactId: contact.id,
          number,
          status: "draft",
          dueDate: new Date(input.dueDate),
          subtotalNet: priced.subtotalNet,
          totalTax: priced.totalTax,
          totalGross: priced.totalGross,
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
          ...(origin
            ? {
                recurringInvoiceId: origin.recurringInvoiceId,
                recurringRunDate: origin.recurringRunDate,
              }
            : {}),
          items: { create: priced.itemRows },
        },
        include: { items: { orderBy: { sortOrder: "asc" } } },
      })
    )

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
  handle: (input) =>
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
      if (existing.lastEmailAttemptOutcome === "sending") {
        return yield* new InvalidState({
          message: "This invoice is being emailed. Wait for that delivery to finish before changing it.",
          code: "send_in_progress",
        })
      }

      const { settings, profile } = yield* loadDocumentContext
      const pricesIncludeTax = settings.pricesIncludeTax
      const data: Parameters<typeof db.invoice.update>[0]["data"] = {}

      if (input.contactId) {
        const contact = yield* findContact(input.contactId)
        data.contact = { connect: { id: contact.id } }
        data.buyerSnapshot = buildBuyerSnapshot(contact)
      }
      if (input.dueDate) data.dueDate = new Date(input.dueDate)
      if (input.currency) data.currency = input.currency
      if (input.notes !== undefined) data.notes = input.notes

      // A currency change can change rounding precision, so it reprices too.
      if (input.items || input.taxRate !== undefined || input.currency !== undefined) {
        const items =
          input.items ??
          existing.items.map((item) => ({
            description: item.description,
            quantity: item.quantity.toNumber(),
            unitPrice: pricesIncludeTax ? item.unitPriceGross.toNumber() : item.unitPriceNet.toNumber(),
          }))
        const priced = priceDocument({
          profile,
          items,
          taxRate: input.taxRate ?? impliedTaxRate(existing),
          pricesIncludeTax,
          currency: input.currency ?? existing.currency,
        })

        data.subtotalNet = priced.subtotalNet
        data.totalTax = priced.totalTax
        data.totalGross = priced.totalGross
        yield* Effect.promise(() => db.invoiceItem.deleteMany({ where: { invoiceId: existing.id } }))
        data.items = { create: priced.itemRows }
      }

      const invoice = yield* Effect.promise(() =>
        db.invoice.update({
          where: { id: existing.id },
          data,
          include: { contact: true, items: { orderBy: { sortOrder: "asc" } } },
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

      yield* Effect.promise(() => db.invoice.delete({ where: { id: invoice.id } }))
      command.emit({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "invoice.draft_deleted",
        payload: { number: invoice.number },
      })
      return { id: invoice.id }
    }),
})

/** What a person approving an agent's invoice email sees, versioned by the invoice's last change. */
const invoiceEmailApprovalContext = (id: string, action: "send" | "resend") =>
  Effect.gen(function* () {
    yield* lockDocument("invoice", id)
    const found = yield* findInvoice(id)
    // Lock the contact before reading the address, so the approved recipient cannot change.
    const invoice = { ...found, contact: { ...found.contact, ...(yield* lockedContact(found.contactId)) } }
    const recipient = invoice.contact.email?.trim() || null
    const total = `${invoice.totalGross.toFixed(2)} ${invoice.currency}`
    return {
      summary:
        action === "send"
          ? `Send invoice ${invoice.number} (${total}) to ${recipient ?? invoice.contact.name}`
          : `Email invoice ${invoice.number} (${total}) to ${recipient ?? invoice.contact.name} again`,
      version: documentFingerprint(invoice, recipient, [invoice.dueDate]),
      details: {
        number: invoice.number,
        customer: invoice.contact.name,
        recipient,
        total: invoice.totalGross.toFixed(2),
        currency: invoice.currency,
        dueDate: invoice.dueDate.toISOString().slice(0, 10),
      },
    }
  })

/** Delivery is attempted right after the command commits; `emailPending` is true until then. */
export type InvoiceSendResult = Awaited<ReturnType<typeof prisma.invoice.update>> & {
  emailSent: boolean
  emailPending: boolean
  emailSkipReason?: string
}

export const sendInvoice = defineCommand({
  type: "invoice.send",
  permission: "invoice:send",
  outwardFacing: true,
  input: invoiceSendInputSchema,
  summarize: (input) => `Send invoice ${input.id} to the customer`,
  approvalContext: (input) => invoiceEmailApprovalContext(input.id, "send"),
  // The invoice is marked as being sent and the rendered email is queued in the outbox; the
  // invoice becomes sent only once the provider accepts the email. See `delivery/outbox.ts`.
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command
      yield* lockDocument("invoice", input.id)
      const invoice = yield* findInvoice(input.id)

      if (invoice.status !== "draft") {
        return yield* new InvalidState({ message: "Only draft invoices can be sent", code: "not_draft" })
      }
      yield* refuseWhileSending("invoice", invoice)

      const { settings, sellerTaxIds, profile } = yield* loadDocumentContext
      const emailContext = resolveInvoiceEmailContext(settings)
      const compliance = assessCompliance(profile, sellerTaxIds, impliedTaxRate(invoice))
      if (compliance.blocking.length > 0) {
        return yield* new InvalidState({
          message: `Compliance check failed: ${compliance.blocking.map((issue) => issue.code).join(", ")}`,
          code: "compliance_failed",
        })
      }
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
              status: "sent",
              issueDate: now,
              publicPaymentIssuedAt: emailContext.stripeConfigured ? (invoice.publicPaymentIssuedAt ?? now) : null,
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
      const publicPaymentIssuedAt = emailContext.stripeConfigured ? (invoice.publicPaymentIssuedAt ?? now) : null
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
        invoice: { ...invoice, issueDate: now },
        settings,
        to: recipient,
        publicPaymentUrl,
      })
      const updated = yield* queueDocumentEmail({
        kind: "invoice",
        mode: "send",
        document: invoice,
        recipient,
        message: email.message,
        idempotencyKey: `invoice-send:${invoice.id}:${now.getTime()}`,
        publicLinkIssuedAt: publicPaymentIssuedAt,
        markSending: (data) => db.invoice.update({ where: { id: invoice.id }, data }),
      })
      invoiceLogger.info("invoice.email.queued", {
        organizationId,
        invoiceId: invoice.id,
        usingBrandedDomain: email.usingBrandedDomain,
        hasPublicPaymentUrl: Boolean(publicPaymentUrl),
      })
      const result: InvoiceSendResult = { ...updated, emailSent: false, emailPending: true }
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
        emailContext.stripeConfigured && invoice.publicPaymentIssuedAt
          ? getPublicInvoicePaymentUrl(invoice)
          : null
      const recipient = yield* requireRecipientEmail(invoice.contact)
      if (!emailContext.emailDelivery.available) {
        return yield* new InvalidState({
          message: "Email delivery is not configured",
          code: "email_unavailable",
        })
      }

      const email = composeInvoiceEmail({ invoice, settings, to: recipient, publicPaymentUrl })
      const updated = yield* queueDocumentEmail({
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
      const result: InvoiceSendResult = { ...updated, emailSent: false, emailPending: true }
      return result
    }),
})

export const invoiceCommands = [
  createInvoiceDraft,
  updateInvoiceDraft,
  deleteInvoiceDraft,
  sendInvoice,
  resendInvoiceEmail,
] as const
