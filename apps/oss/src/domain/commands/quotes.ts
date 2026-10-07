import { requireDraftCurrency } from "../documents/currency"
import { Effect } from "effect"
import { z } from "zod"
import {
  quoteCreateDraftInputSchema,
  quoteIdInputSchema,
  quotePublicDecisionSchema,
  quoteSendInputSchema,
  quoteUpdateDraftInputSchema,
} from "@quits/contracts/quotes"
import { billingProvider } from "../../lib/billing"
import { createEmailDeliveryAttempt } from "../../lib/email-delivery"
import { appLogger } from "../../lib/observability"
import { assertCloudOnboardingComplete } from "../../lib/onboarding/guard"
import { toNullableJsonInput } from "../../lib/prisma-json"
import { applyPublicQuoteDecision } from "../../lib/quotes/public"
import { getPublicQuoteUrl } from "../../lib/quotes/public-url"
import { defineCommand } from "../command"
import { assessCompliance, loadDocumentContext } from "../documents/context"
import { queueDocumentEmail, refuseWhileSending } from "../documents/document-delivery"
import { lockDocument } from "../documents/locks"
import { documentFingerprint, lockedContact } from "../approval-contexts"
import { allocateDocumentNumber } from "../documents/numbering"
import { impliedTaxRate, priceDocument } from "../documents/pricing"
import {
  composeQuoteEmail,
  requireRecipientEmail,
  resolveQuoteEmailContext,
} from "../documents/quote-email"
import { buildBuyerSnapshot, buildSellerSnapshot, buyerContactSelect } from "../documents/snapshots"
import { InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"
import { prisma } from "../../lib/db"

const quoteLogger = appLogger.child("quotes")

/** Runs a check that signals failure by throwing (onboarding). */
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

const findQuote = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const quote = yield* Effect.promise(() =>
      db.quote.findFirst({
        where: { id, organizationId },
        include: { contact: true, items: { orderBy: { sortOrder: "asc" } } },
      })
    )
    if (!quote) {
      return yield* new NotFound({ message: "Quote not found", entity: "quote", id })
    }
    return quote
  })

export const createQuoteDraft = defineCommand({
  type: "quote.create_draft",
  permission: "quote:create",
  outwardFacing: false,
  input: quoteCreateDraftInputSchema,
  summarize: (input) => `Create a draft quote with ${input.items.length} line(s)`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId } = command

      yield* precondition(() => assertCloudOnboardingComplete(organizationId))
      const contact = yield* findContact(input.contactId)

      const { settings, sellerTaxIds, profile } = yield* loadDocumentContext
      const number = yield* allocateDocumentNumber("quote")
      const currency = input.currency ?? settings.defaultCurrency ?? settings.currency
      yield* requireDraftCurrency(currency)
      const priced = priceDocument({
        profile,
        items: input.items,
        taxRate: input.taxRate,
        pricesIncludeTax: settings.pricesIncludeTax,
        currency,
      })
      const compliance = assessCompliance(profile, sellerTaxIds, input.taxRate)

      const quote = yield* Effect.promise(() =>
        db.quote.create({
          data: {
            organizationId,
            contactId: contact.id,
            number,
            status: "draft",
            expiryDate: new Date(input.expiryDate),
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
            items: { create: priced.itemRows },
          },
          include: { items: { orderBy: { sortOrder: "asc" } } },
        })
      )

      command.emit({
        aggregateType: "quote",
        aggregateId: quote.id,
        type: "quote.draft_created",
        payload: { number: quote.number, contactId: contact.id, totalGross: priced.totalGross },
      })
      return quote
    }),
})

export const updateQuoteDraft = defineCommand({
  type: "quote.update_draft",
  permission: "quote:update",
  outwardFacing: false,
  input: quoteUpdateDraftInputSchema,
  summarize: (input) => `Update draft quote ${input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      yield* lockDocument("quote", input.id)
      const existing = yield* findQuote(input.id)

      if (existing.status !== "draft") {
        return yield* new InvalidState({
          message: "Only draft quotes can be edited",
          code: "not_draft",
        })
      }
      if (existing.lastEmailAttemptOutcome === "sending") {
        return yield* new InvalidState({
          message: "This quote is being emailed. Wait for that delivery to finish before changing it.",
          code: "send_in_progress",
        })
      }

      const { settings, profile } = yield* loadDocumentContext
      const pricesIncludeTax = settings.pricesIncludeTax
      const data: Parameters<typeof db.quote.update>[0]["data"] = {}

      if (input.contactId) {
        const contact = yield* findContact(input.contactId)
        data.contact = { connect: { id: contact.id } }
        data.buyerSnapshot = buildBuyerSnapshot(contact)
      }
      if (input.expiryDate) data.expiryDate = new Date(input.expiryDate)
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
        yield* Effect.promise(() => db.quoteItem.deleteMany({ where: { quoteId: existing.id } }))
        data.items = { create: priced.itemRows }
      }

      const quote = yield* Effect.promise(() =>
        db.quote.update({
          where: { id: existing.id },
          data,
          include: { contact: true, items: { orderBy: { sortOrder: "asc" } } },
        })
      )

      command.emit({
        aggregateType: "quote",
        aggregateId: quote.id,
        type: "quote.draft_updated",
        payload: { fields: Object.keys(input).filter((key) => key !== "id") },
      })
      return quote
    }),
})

export const deleteQuoteDraft = defineCommand({
  type: "quote.delete_draft",
  permission: "quote:delete",
  outwardFacing: false,
  input: quoteIdInputSchema,
  summarize: (input) => `Delete draft quote ${input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      yield* lockDocument("quote", input.id)
      const quote = yield* findQuote(input.id)
      if (quote.status !== "draft") {
        return yield* new InvalidState({
          message: "Only draft quotes can be deleted",
          code: "not_draft",
        })
      }
      if (quote.lastEmailAttemptOutcome === "sending") {
        return yield* new InvalidState({
          message: "This quote is being emailed. Wait for that delivery to finish before changing it.",
          code: "send_in_progress",
        })
      }

      const deleted = yield* Effect.promise(() => db.quote.delete({ where: { id: quote.id } }))
      command.emit({
        aggregateType: "quote",
        aggregateId: quote.id,
        type: "quote.draft_deleted",
        payload: { number: quote.number },
      })
      return deleted
    }),
})

/** What a person approving an agent's quote email sees, versioned by the quote's last change. */
const quoteEmailApprovalContext = (id: string, action: "send" | "resend") =>
  Effect.gen(function* () {
    yield* lockDocument("quote", id)
    const found = yield* findQuote(id)
    // Lock the contact before reading the address, so the approved recipient cannot change.
    const quote = { ...found, contact: { ...found.contact, ...(yield* lockedContact(found.contactId)) } }
    const recipient = quote.contact.email?.trim() || null
    const total = `${quote.totalGross.toFixed(2)} ${quote.currency}`
    return {
      summary:
        action === "send"
          ? `Send quote ${quote.number} (${total}) to ${recipient ?? quote.contact.name}`
          : `Email quote ${quote.number} (${total}) to ${recipient ?? quote.contact.name} again`,
      version: documentFingerprint(quote, recipient, [quote.expiryDate]),
      details: {
        number: quote.number,
        customer: quote.contact.name,
        recipient,
        total: quote.totalGross.toFixed(2),
        currency: quote.currency,
        expiryDate: quote.expiryDate.toISOString().slice(0, 10),
      },
    }
  })

/** Delivery is attempted right after the command commits; `emailPending` is true until then. */
export type QuoteSendResult = Awaited<ReturnType<typeof prisma.quote.update>> & {
  emailSent: boolean
  emailPending: boolean
  emailSkipReason?: string
  /** Identifies the queued delivery, whose outcome `readDeliveryResult` reports. */
  deliveryKey?: string
}

export const sendQuote = defineCommand({
  type: "quote.send",
  permission: "quote:send",
  outwardFacing: true,
  input: quoteSendInputSchema,
  summarize: (input) => `Send quote ${input.id} to the customer`,
  approvalContext: (input) => quoteEmailApprovalContext(input.id, "send"),
  // The quote becomes sent once the provider accepts the queued email; see `sendInvoice`.
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId, now } = command
      yield* lockDocument("quote", input.id)
      const quote = yield* findQuote(input.id)

      if (quote.status !== "draft") {
        return yield* new InvalidState({ message: "Only draft quotes can be sent", code: "not_draft" })
      }
      yield* refuseWhileSending("quote", quote)

      const { settings, sellerTaxIds, profile } = yield* loadDocumentContext
      const compliance = assessCompliance(profile, sellerTaxIds, impliedTaxRate(quote))
      if (compliance.blocking.length > 0) {
        return yield* new InvalidState({
          message: `Compliance check failed: ${compliance.blocking.map((issue) => issue.code).join(", ")}`,
          code: "compliance_failed",
        })
      }

      // The emailed link is signed with the date the quote will be shared at.
      const publicAccessIssuedAt = quote.publicAccessIssuedAt ?? now
      const publicQuoteUrl = getPublicQuoteUrl({
        id: quote.id,
        status: "sent",
        publicAccessIssuedAt,
        publicAccessKeyVersion: quote.publicAccessKeyVersion,
      })
      const emailContext = resolveQuoteEmailContext(settings)
      const recipient = yield* requireRecipientEmail(quote.contact)

      if (!emailContext.emailDelivery.available) {
        if (!input.allowSendWithoutEmail) {
          return yield* new InvalidState({
            message: "Email delivery is not configured",
            code: "email_unavailable",
          })
        }
        const emailSkipReason = "Email delivery is not configured"
        quoteLogger.warn("quote.email.skipped", { organizationId, quoteId: quote.id, reason: "provider_missing" })
        const updated = yield* Effect.promise(() =>
          db.quote.update({
            where: { id: quote.id },
            data: {
              status: "sent",
              issueDate: now,
              publicAccessIssuedAt,
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
          aggregateType: "quote",
          aggregateId: quote.id,
          type: "quote.sent",
          payload: { number: quote.number, emailSent: false, recipient },
        })
        const result: QuoteSendResult = { ...updated, emailSent: false, emailPending: false, emailSkipReason }
        return result
      }

      const email = composeQuoteEmail({
        quote: { ...quote, issueDate: now },
        settings,
        to: recipient,
        publicQuoteUrl,
      })
      const { document: updated, deliveryKey } = yield* queueDocumentEmail({
        kind: "quote",
        mode: "send",
        document: quote,
        recipient,
        message: email.message,
        idempotencyKey: `quote-send:${quote.id}:${now.getTime()}`,
        publicLinkIssuedAt: publicAccessIssuedAt,
        markSending: (data) => db.quote.update({ where: { id: quote.id }, data }),
      })
      quoteLogger.info("quote.email.queued", {
        organizationId,
        quoteId: quote.id,
        usingBrandedDomain: email.usingBrandedDomain,
        hasPublicQuoteUrl: Boolean(publicQuoteUrl),
      })
      const result: QuoteSendResult = { ...updated, emailSent: false, emailPending: true, deliveryKey }
      return result
    }),
})

export const resendQuoteEmail = defineCommand({
  type: "quote.resend_email",
  permission: "quote:send",
  outwardFacing: true,
  input: quoteIdInputSchema,
  summarize: (input) => `Email quote ${input.id} to the customer again`,
  approvalContext: (input) => quoteEmailApprovalContext(input.id, "resend"),
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId } = command
      yield* lockDocument("quote", input.id)
      const quote = yield* findQuote(input.id)

      if (!["sent", "accepted", "rejected"].includes(quote.status)) {
        return yield* new InvalidState({
          message: "Only shared quotes can be resent by email",
          code: "not_shared",
        })
      }
      yield* refuseWhileSending("quote", quote)

      const publicQuoteUrl = getPublicQuoteUrl(quote)
      if (!publicQuoteUrl) {
        return yield* new InvalidState({
          message: "Quote has no public link to resend",
          code: "no_public_link",
        })
      }

      const { settings } = yield* loadDocumentContext
      const emailContext = resolveQuoteEmailContext(settings)
      const recipient = yield* requireRecipientEmail(quote.contact)
      if (!emailContext.emailDelivery.available) {
        return yield* new InvalidState({
          message: "Email delivery is not configured",
          code: "email_unavailable",
        })
      }

      const email = composeQuoteEmail({ quote, settings, to: recipient, publicQuoteUrl })
      const { document: updated, deliveryKey } = yield* queueDocumentEmail({
        kind: "quote",
        mode: "email",
        document: quote,
        recipient,
        message: email.message,
        idempotencyKey: `quote-resend:${command.commandId}`,
        markSending: (data) => db.quote.update({ where: { id: quote.id }, data }),
      })
      quoteLogger.info("quote.email.resend_queued", {
        organizationId,
        quoteId: quote.id,
        usingBrandedDomain: email.usingBrandedDomain,
        hasPublicQuoteUrl: Boolean(publicQuoteUrl),
      })
      const result: QuoteSendResult = { ...updated, emailSent: false, emailPending: true, deliveryKey }
      return result
    }),
})

export const rejectQuote = defineCommand({
  type: "quote.reject",
  permission: "quote:update",
  outwardFacing: false,
  input: quoteIdInputSchema,
  summarize: (input) => `Mark quote ${input.id} as rejected`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      yield* lockDocument("quote", input.id)
      const quote = yield* findQuote(input.id)

      if (quote.status !== "sent") {
        return yield* new InvalidState({
          message: "Only sent quotes can be rejected",
          code: "not_sent",
        })
      }

      const updated = yield* Effect.promise(() =>
        db.quote.update({ where: { id: quote.id }, data: { status: "rejected" } })
      )
      command.emit({
        aggregateType: "quote",
        aggregateId: quote.id,
        type: "quote.rejected",
        payload: { number: quote.number, source: "user" },
      })
      return updated
    }),
})

export const convertQuoteToInvoice = defineCommand({
  type: "quote.convert_to_invoice",
  permission: "invoice:create",
  outwardFacing: false,
  input: quoteIdInputSchema,
  summarize: (input) => `Convert accepted quote ${input.id} into a draft invoice`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId } = command
      yield* lockDocument("quote", input.id)
      const quote = yield* findQuote(input.id)

      if (quote.status !== "accepted") {
        return yield* new InvalidState({
          message: "Only accepted quotes can be converted to invoices",
          code: "not_accepted",
        })
      }

      // Conversion creates an invoice, so it is subject to the same billing limits.
      yield* precondition(() => billingProvider.assertInvoiceCreationAllowed(organizationId))

      const number = yield* allocateDocumentNumber("invoice")
      const invoice = yield* Effect.promise(() =>
        db.invoice.create({
          data: {
            organizationId,
            contactId: quote.contactId,
            number,
            status: "draft",
            dueDate: quote.expiryDate,
            supplyDate: quote.supplyDate,
            subtotalNet: quote.subtotalNet,
            totalTax: quote.totalTax,
            totalGross: quote.totalGross,
            currency: quote.currency,
            countryCode: quote.countryCode,
            locale: quote.locale,
            timezone: quote.timezone,
            taxRegime: quote.taxRegime,
            pricesIncludeTax: quote.pricesIncludeTax,
            sellerSnapshot: toNullableJsonInput(quote.sellerSnapshot),
            buyerSnapshot: toNullableJsonInput(quote.buyerSnapshot),
            complianceStatus: quote.complianceStatus,
            complianceErrors: toNullableJsonInput(quote.complianceErrors),
            legalText: toNullableJsonInput(quote.legalText),
            paymentReference: quote.paymentReference,
            purchaseOrderRef: quote.purchaseOrderRef,
            notes: quote.notes,
            quoteId: quote.id,
            items: {
              create: quote.items.map((item) => ({
                description: item.description,
                quantity: item.quantity,
                unitPriceNet: item.unitPriceNet,
                unitPriceGross: item.unitPriceGross,
                lineNet: item.lineNet,
                lineTax: item.lineTax,
                lineGross: item.lineGross,
                taxRate: item.taxRate,
                taxCategory: item.taxCategory,
                taxCode: item.taxCode,
                sortOrder: item.sortOrder,
              })),
            },
          },
          include: { items: { orderBy: { sortOrder: "asc" } } },
        })
      )

      command.emit({
        aggregateType: "quote",
        aggregateId: quote.id,
        type: "quote.converted",
        payload: { number: quote.number, invoiceId: invoice.id, invoiceNumber: invoice.number },
      })
      command.emit({
        aggregateType: "invoice",
        aggregateId: invoice.id,
        type: "invoice.draft_created",
        payload: {
          number: invoice.number,
          contactId: invoice.contactId,
          totalGross: invoice.totalGross.toNumber(),
          quoteId: quote.id,
        },
      })
      return invoice
    }),
})

export const quoteCustomerDecisionInputSchema = z.object({
  quoteId: z.string().min(1),
  keyVersion: z.number().int().positive(),
  decision: quotePublicDecisionSchema,
  rejectionReason: z.string().trim().max(500).optional(),
})

/**
 * Records the customer's accept or reject decision from a signed public link. The link
 * signature is verified by the caller; this command only runs for the customer actor and is
 * deliberately not part of `quoteCommands`, so users and agents cannot decide on a customer's
 * behalf.
 */
export const recordQuoteCustomerDecision = defineCommand({
  type: "quote.record_customer_decision",
  permission: "quote:update",
  outwardFacing: false,
  input: quoteCustomerDecisionInputSchema,
  summarize: (input) => `Record the customer's ${input.decision} decision on quote ${input.quoteId}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      if (command.actor.kind !== "system" || command.actor.reason !== "customer_link") {
        return yield* new InvalidState({
          message: "Only the customer can decide on a quote",
          code: "customer_only",
        })
      }

      const current = yield* Effect.promise(() =>
        db.quote.findFirst({
          where: {
            id: input.quoteId,
            organizationId: command.organizationId,
            publicAccessKeyVersion: input.keyVersion,
            publicAccessIssuedAt: { not: null },
            status: { in: ["sent", "accepted", "rejected"] },
          },
        })
      )
      if (!current) {
        return yield* new NotFound({ message: "Quote not found", entity: "quote", id: input.quoteId })
      }

      const next = yield* Effect.try({
        try: () =>
          applyPublicQuoteDecision(
            {
              status: current.status,
              publicDecisionAt: current.publicDecisionAt,
              publicRejectionReason: current.publicRejectionReason,
            },
            {
              decision: input.decision,
              decidedAt: command.now,
              rejectionReason: input.rejectionReason,
            }
          ),
        catch: (error) =>
          new InvalidState({
            message: error instanceof Error ? error.message : "Quote cannot be decided",
            code: "already_decided",
          }),
      })

      const quote = yield* Effect.promise(() =>
        db.quote.update({
          where: { id: current.id },
          data: {
            status: next.status,
            publicDecisionAt: next.publicDecisionAt,
            publicRejectionReason: next.publicRejectionReason,
          },
          include: {
            contact: { select: { name: true, email: true, company: true } },
            items: { orderBy: { sortOrder: "asc" } },
            invoices: { select: { id: true, number: true, status: true } },
          },
        })
      )

      command.emit({
        aggregateType: "quote",
        aggregateId: quote.id,
        type: input.decision === "accepted" ? "quote.accepted" : "quote.rejected",
        payload: {
          number: quote.number,
          source: "customer",
          ...(next.publicRejectionReason ? { rejectionReason: next.publicRejectionReason } : {}),
        },
      })
      return quote
    }),
})

export const quoteCommands = [
  createQuoteDraft,
  updateQuoteDraft,
  deleteQuoteDraft,
  sendQuote,
  resendQuoteEmail,
  rejectQuote,
  convertQuoteToInvoice,
] as const
