import { Effect } from "effect"
import {
  agreementCreateDraftInputSchema,
  type agreementCreateDraftRequestSchema,
} from "@quits/contracts/agreements"
import type { z } from "zod"
import { Command, Db } from "../services"
import { lockDocument } from "../documents/locks"
import { refuseWhileSending } from "../documents/document-delivery"
import { storedDraftItems } from "../documents/pricing"
import { InvalidState, NotFound } from "../errors"
import { seedAgreementTemplates } from "./templates"

/** The quote lock serializes both conversion paths, including requests with different ids. */
export function resolveQuoteDraft(
  request: z.infer<typeof agreementCreateDraftRequestSchema>,
) {
  return Effect.gen(function* () {
    if (!("sourceQuoteId" in request)) return { input: request, quote: null }
    const db = yield* Db
    const { organizationId } = yield* Command
    yield* lockDocument("quote", request.sourceQuoteId, { strength: "update" })
    const quote = yield* Effect.promise(() =>
      db.quote.findFirst({
        where: { id: request.sourceQuoteId, organizationId },
        include: {
          items: { orderBy: { sortOrder: "asc" } },
          invoices: { select: { id: true } },
          agreement: { select: { id: true } },
        },
      }),
    )
    if (!quote)
      return yield* new NotFound({
        entity: "quote",
        id: request.sourceQuoteId,
        message: "Quote not found",
      })
    yield* refuseWhileSending("quote", quote)
    if (quote.status !== "accepted")
      return yield* new InvalidState({
        code: "not_accepted",
        message: "Only accepted quotes can be converted to agreements",
      })
    if (quote.invoices.length)
      return yield* new InvalidState({
        code: "quote_has_invoices",
        message:
          "This quote already has invoices and cannot be converted to an agreement.",
      })
    if (quote.agreement)
      return yield* new InvalidState({
        code: "quote_has_agreement",
        message: "This quote already has an agreement.",
      })
    let templateId = request.templateId
    if (templateId === undefined) {
      yield* Effect.promise(() => seedAgreementTemplates(db, organizationId))
      templateId =
        (yield* Effect.promise(() =>
          db.agreementTemplate.findFirst({
            where: { organizationId, isDefault: true },
          }),
        ))?.id ?? null
    }
    const template = templateId
      ? yield* Effect.promise(() =>
          db.agreementTemplate.findFirst({
            where: { id: templateId, organizationId },
          }),
        )
      : null
    if (templateId && !template)
      return yield* new InvalidState({
        code: "invalid_template",
        message: "Invalid template for this organization",
      })
    const input = agreementCreateDraftInputSchema.parse({
      contactId: quote.contactId,
      title: request.title ?? quote.number,
      validUntil: request.validUntil,
      templateId,
      termsMarkdown: request.termsMarkdown ?? template?.termsMarkdown ?? "",
      dueInDays: request.dueInDays,
      billingTrigger: request.billingTrigger,
      currency: quote.currency,
      taxRate: quote.items[0]?.taxRate.toString() ?? "0",
      notes: quote.notes,
      deliverables: storedDraftItems(quote).map((line, index) => ({
        title: line.description.trim().slice(0, 200) || quote.number,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        // Legacy non-taxed lines used standard/0. V2 makes the zero-tax treatment explicit,
        // as frozenInvoiceLine already does for agreement billing.
        vat: line.vat
          ? {
              ...line.vat,
              treatment:
                quote.items[index]!.vatTreatment === "standard" &&
                quote.items[index]!.taxRate.isZero()
                  ? "out_of_scope"
                  : line.vat.treatment,
            }
          : undefined,
        isDeposit: false,
        agreedDate: quote.supplyDate?.toISOString().slice(0, 10) ?? null,
      })),
    })
    return { input, quote }
  })
}
