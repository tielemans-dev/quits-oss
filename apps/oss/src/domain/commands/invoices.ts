import { Effect } from "effect"
import {
  invoiceCreateDraftInputSchema,
  invoiceIdInputSchema,
  invoiceSendInputSchema,
  invoiceUpdateDraftInputSchema,
} from "@yaip/contracts/invoices"
import type { z } from "zod"
import { billingProvider } from "../../lib/billing"
import { createEmailDeliveryAttempt } from "../../lib/email-delivery"
import { appLogger } from "../../lib/observability"
import { assertCloudOnboardingComplete } from "../../lib/onboarding/guard"
import { getPublicInvoicePaymentUrl } from "../../lib/payments/public"
import { defineCommand } from "../command"
import { assessCompliance, loadDocumentContext } from "../documents/context"
import {
  deliverInvoiceEmail,
  requireRecipientEmail,
  resolveInvoiceEmailContext,
} from "../documents/invoice-email"
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
    const priced = priceDocument({
      profile,
      items: input.items,
      taxRate: input.taxRate,
      pricesIncludeTax: settings.pricesIncludeTax,
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
          currency: input.currency ?? settings.defaultCurrency ?? settings.currency,
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
      const existing = yield* findInvoice(input.id)

      if (existing.status !== "draft") {
        return yield* new InvalidState({
          message: "Only draft invoices can be edited",
          code: "not_draft",
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

      if (input.items || input.taxRate !== undefined) {
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
      const invoice = yield* findInvoice(input.id)
      if (invoice.status !== "draft") {
        return yield* new InvalidState({
          message: "Only draft invoices can be deleted",
          code: "not_draft",
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

export const sendInvoice = defineCommand({
  type: "invoice.send",
  permission: "invoice:send",
  outwardFacing: true,
  input: invoiceSendInputSchema,
  summarize: (input) => `Send invoice ${input.id} to the customer`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command
      const invoice = yield* findInvoice(input.id)

      if (invoice.status !== "draft") {
        return yield* new InvalidState({ message: "Only draft invoices can be sent", code: "not_draft" })
      }

      const { settings, sellerTaxIds, profile } = yield* loadDocumentContext
      const compliance = assessCompliance(profile, sellerTaxIds, impliedTaxRate(invoice))
      if (compliance.blocking.length > 0) {
        return yield* new InvalidState({
          message: `Compliance check failed: ${compliance.blocking.map((issue) => issue.code).join(", ")}`,
          code: "compliance_failed",
        })
      }

      const emailContext = resolveInvoiceEmailContext(settings)
      const publicPaymentIssuedAt = emailContext.stripeConfigured
        ? (invoice.publicPaymentIssuedAt ?? now)
        : null
      const publicPaymentUrl = emailContext.stripeConfigured
        ? getPublicInvoicePaymentUrl({
            id: invoice.id,
            status: "sent",
            paymentStatus: invoice.paymentStatus,
            publicPaymentIssuedAt,
            publicPaymentKeyVersion: invoice.publicPaymentKeyVersion,
          })
        : null
      const recipient = yield* requireRecipientEmail(invoice.contact)

      let emailSent = false
      let emailSkipReason: string | undefined
      let attempt = createEmailDeliveryAttempt({
        at: now,
        outcome: "sent",
        code: "sent",
        message: "Invoice email sent.",
      })

      if (!emailContext.emailDelivery.available) {
        if (!input.allowSendWithoutEmail) {
          return yield* new InvalidState({
            message: "Email delivery is not configured",
            code: "email_unavailable",
          })
        }
        emailSkipReason = "Email delivery is not configured"
        attempt = createEmailDeliveryAttempt({
          at: now,
          outcome: "skipped",
          code: "provider_missing",
          message: emailSkipReason,
        })
        invoiceLogger.warn("invoice.email.skipped", {
          organizationId,
          invoiceId: invoice.id,
          reason: "provider_missing",
        })
      } else {
        const delivery = yield* deliverInvoiceEmail({
          invoice: { ...invoice, issueDate: now },
          settings,
          to: recipient,
          publicPaymentUrl,
          failureMessage: "Failed to send invoice email. Invoice was not marked as sent.",
        })
        emailSent = true
        invoiceLogger.info("invoice.email.sent", {
          organizationId,
          invoiceId: invoice.id,
          usingBrandedDomain: delivery.usingBrandedDomain,
          hasPublicPaymentUrl: Boolean(publicPaymentUrl),
        })
      }

      const updated = yield* Effect.promise(() =>
        db.invoice.update({
          where: { id: invoice.id },
          data: { status: "sent", issueDate: now, publicPaymentIssuedAt, ...attempt },
        })
      )

      command.emit({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "invoice.sent",
        payload: { number: invoice.number, emailSent, recipient },
      })
      return { ...updated, emailSent, emailSkipReason }
    }),
})

export const resendInvoiceEmail = defineCommand({
  type: "invoice.resend_email",
  permission: "invoice:send",
  outwardFacing: true,
  input: invoiceIdInputSchema,
  summarize: (input) => `Email invoice ${input.id} to the customer again`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const invoice = yield* findInvoice(input.id)

      if (!["sent", "overdue"].includes(invoice.status)) {
        return yield* new InvalidState({
          message: "Only sent or overdue invoices can be resent by email",
          code: "not_sent",
        })
      }

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

      const delivery = yield* deliverInvoiceEmail({
        invoice,
        settings,
        to: recipient,
        publicPaymentUrl,
        failureMessage: "Failed to resend invoice email.",
      })
      invoiceLogger.info("invoice.email.resent", {
        organizationId: command.organizationId,
        invoiceId: invoice.id,
        usingBrandedDomain: delivery.usingBrandedDomain,
        hasPublicPaymentUrl: Boolean(publicPaymentUrl),
      })

      const updated = yield* Effect.promise(() =>
        db.invoice.update({
          where: { id: invoice.id },
          data: createEmailDeliveryAttempt({
            at: command.now,
            outcome: "sent",
            code: "sent",
            message: "Invoice email sent.",
          }),
        })
      )

      command.emit({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "invoice.email_resent",
        payload: { number: invoice.number, recipient },
      })
      return { ...updated, emailSent: true, emailSkipReason: undefined }
    }),
})

export const invoiceCommands = [
  createInvoiceDraft,
  updateInvoiceDraft,
  deleteInvoiceDraft,
  sendInvoice,
  resendInvoiceEmail,
] as const
