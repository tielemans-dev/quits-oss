import { requireDraftCurrency } from "../documents/currency"
import { deliverableCommands } from "./deliverables"
import {
  lockedDeliverable,
  requireFulfillment,
  requireUnbilled,
  clearedAcceptance,
  acceptanceRecord,
} from "../agreements/fulfillment"
import { agreementLifecycleCommands } from "./agreement-lifecycle"
import { refuseWhileSending } from "../documents/document-delivery"
import { Effect } from "effect"
import {
  agreementCreateDraftInputSchema,
  agreementUpdateDraftInputSchema,
  agreementIdInputSchema,
  deliverableUpdateInputSchema,
} from "@quits/contracts/agreements"
import { assertCloudOnboardingComplete } from "../../lib/onboarding/guard"
import { resolveCountryProfile } from "../../lib/compliance"
import { defineCommand } from "../command"
import { loadDocumentContext } from "../documents/context"
import { lockDocument } from "../documents/locks"
import { buildBuyerSnapshot, buildSellerSnapshot, buyerContactSelect } from "../documents/snapshots"
import { InvalidState, NotFound } from "../errors"
import { Command, Db } from "../services"
import { priceAgreement } from "../agreements/pricing"
import type { Deliverable } from "../../../generated/prisma/client"

const include = { contact: true, deliverables: { orderBy: { sortOrder: "asc" as const } } }
const findContact = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    const contact = yield* Effect.promise(() =>
      db.contact.findFirst({ where: { id, organizationId }, select: buyerContactSelect }),
    )
    if (!contact)
      return yield* new InvalidState({
        message: "Invalid contact for this organization",
        code: "invalid_contact",
      })
    return contact
  })
const validateTemplate = (id: string | null | undefined) =>
  Effect.gen(function* () {
    if (!id) return
    const db = yield* Db
    const { organizationId } = yield* Command
    const template = yield* Effect.promise(() =>
      db.agreementTemplate.findFirst({ where: { id, organizationId } }),
    )
    if (!template)
      return yield* new InvalidState({
        message: "Invalid template for this organization",
        code: "invalid_template",
      })
  })
const lockedDraft = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const { organizationId } = yield* Command
    yield* lockDocument("agreement", id, { strength: "update" })
    const agreement = yield* Effect.promise(() =>
      db.agreement.findFirst({ where: { id, organizationId }, include }),
    )
    if (!agreement)
      return yield* new NotFound({ message: "Agreement not found", entity: "agreement", id })
    yield* refuseWhileSending("agreement", agreement)
    if (agreement.status !== "draft")
      return yield* new InvalidState({
        message: "Only draft agreements can be edited or deleted",
        code: "not_draft",
      })
    return agreement
  })
function lineInput(line: Deliverable, pricesIncludeTax: boolean) {
  return {
    title: line.title,
    description: line.description,
    quantity: line.quantityInput ?? line.quantity.toString(),
    unitPrice: line.unitPriceInput ?? (pricesIncludeTax ? line.unitPriceGross : line.unitPriceNet).toString(),
    agreedDate: line.agreedDate?.toISOString().slice(0, 10) ?? null,
    expectedDate: line.expectedDate?.toISOString().slice(0, 10) ?? null,
    isDeposit: line.isDeposit,
  }
}

export const createAgreementDraft = defineCommand({
  type: "agreement.create_draft",
  permission: "agreement:create",
  outwardFacing: false,
  input: agreementCreateDraftInputSchema,
  summarize: (input) => `Create draft agreement ${input.title}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { organizationId } = command
      yield* Effect.tryPromise({
        try: () => assertCloudOnboardingComplete(organizationId),
        catch: (error) =>
          new InvalidState({
            message: error instanceof Error ? error.message : "Precondition failed",
            code: "precondition_failed",
          }),
      })
      const contact = yield* findContact(input.contactId)
      yield* validateTemplate(input.templateId)
      const { settings, sellerTaxIds, profile } = yield* loadDocumentContext
      const currency = input.currency ?? settings.defaultCurrency
      yield* requireDraftCurrency(currency)
      const priced = priceAgreement({
        profile,
        deliverables: input.deliverables,
        taxRate: input.taxRate,
        pricesIncludeTax: settings.pricesIncludeTax,
        currency,
      })
      const agreement = yield* Effect.promise(() =>
        db.agreement.create({
          data: {
            organizationId,
            contactId: contact.id,
            title: input.title,
            summary: input.summary,
            termsMarkdown: input.termsMarkdown,
            templateId: input.templateId,
            validUntil: new Date(input.validUntil),
            taxRate: input.taxRate,
            currency,
            dueInDays: input.dueInDays,
            billingTrigger: input.billingTrigger,
            notes: input.notes,
            countryCode: settings.countryCode,
            locale: settings.locale,
            timezone: settings.timezone,
            taxRegime: settings.taxRegime,
            pricesIncludeTax: settings.pricesIncludeTax,
            sellerSnapshot: buildSellerSnapshot(settings, sellerTaxIds),
            buyerSnapshot: buildBuyerSnapshot(contact),
            subtotalNet: priced.subtotalNet,
            totalTax: priced.totalTax,
            totalGross: priced.totalGross,
            deliverables: { create: priced.deliverableRows },
          },
          include,
        }),
      )
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: "agreement.draft_created",
        payload: { title: agreement.title, contactId: contact.id, totalGross: priced.totalGross },
      })
      return agreement
    }),
})

export const updateAgreementDraft = defineCommand({
  type: "agreement.update_draft",
  permission: "agreement:update",
  outwardFacing: false,
  input: agreementUpdateDraftInputSchema,
  summarize: (input) => `Update draft agreement ${input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const existing = yield* lockedDraft(input.id)
      yield* validateTemplate(input.templateId)
      const data: Parameters<typeof db.agreement.update>[0]["data"] = {}
      if (input.contactId !== undefined) {
        const contact = yield* findContact(input.contactId)
        data.contact = { connect: { id: contact.id } }
        data.buyerSnapshot = buildBuyerSnapshot(contact)
      }
      if (input.templateId !== undefined)
        data.template = input.templateId
          ? { connect: { id: input.templateId } }
          : { disconnect: true }
      if (input.validUntil !== undefined) data.validUntil = new Date(input.validUntil)
      if (input.title !== undefined) data.title = input.title
      if (input.summary !== undefined) data.summary = input.summary
      if (input.termsMarkdown !== undefined) data.termsMarkdown = input.termsMarkdown
      if (input.notes !== undefined) data.notes = input.notes
      if (input.dueInDays !== undefined) data.dueInDays = input.dueInDays
      if (input.billingTrigger !== undefined) data.billingTrigger = input.billingTrigger
      if (input.currency !== undefined) data.currency = input.currency
      if (input.taxRate !== undefined) data.taxRate = input.taxRate
      if (
        input.deliverables !== undefined ||
        input.taxRate !== undefined ||
        input.currency !== undefined
      ) {
        const priced = priceAgreement({
          profile: resolveCountryProfile(existing.countryCode),
          deliverables:
            input.deliverables ??
            existing.deliverables.map((line) => lineInput(line, existing.pricesIncludeTax)),
          taxRate: input.taxRate ?? existing.taxRate.toNumber(),
          currency: input.currency ?? existing.currency,
          pricesIncludeTax: existing.pricesIncludeTax,
        })
        data.subtotalNet = priced.subtotalNet
        data.totalTax = priced.totalTax
        data.totalGross = priced.totalGross
        if (input.deliverables !== undefined) {
          yield* Effect.promise(() =>
            db.deliverable.deleteMany({ where: { agreementId: existing.id } }),
          )
          data.deliverables = { create: priced.deliverableRows }
        } else {
          for (const [index, line] of existing.deliverables.entries()) {
            yield* Effect.promise(() =>
              db.deliverable.update({
                where: { id: line.id },
                data: priced.deliverableRows[index]!,
              }),
            )
          }
        }
      }
      const agreement = yield* Effect.promise(() =>
        db.agreement.update({ where: { id: existing.id }, data, include }),
      )
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: "agreement.draft_updated",
        payload: { fields: Object.keys(input).filter((key) => key !== "id") },
      })
      return agreement
    }),
})

export const deleteAgreementDraft = defineCommand({
  type: "agreement.delete_draft",
  permission: "agreement:delete",
  outwardFacing: false,
  input: agreementIdInputSchema,
  summarize: (input) => `Delete draft agreement ${input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const agreement = yield* lockedDraft(input.id)
      const pending = yield* Effect.promise(() =>
        db.approvalRequest.findFirst({
          where: {
            organizationId: command.organizationId,
            status: "pending",
            commandType: { startsWith: "agreement." },
            command: { path: ["id"], equals: agreement.id },
          },
        }),
      )
      if (pending)
        return yield* new InvalidState({
          message: "This agreement has a pending approval",
          code: "approval_pending",
        })
      yield* Effect.promise(() => db.agreement.delete({ where: { id: agreement.id } }))
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: "agreement.draft_deleted",
        payload: { title: agreement.title, number: agreement.number },
      })
      return { id: agreement.id }
    }),
})

export const updateDeliverable = defineCommand({
  type: "deliverable.update",
  permission: "deliverable:update",
  outwardFacing: false,
  input: deliverableUpdateInputSchema,
  summarize: (input) => `Update deliverable ${input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const { agreement, line: existing } = yield* lockedDeliverable(input)
      const { id, agreementId: _agreementId, status, expectedDate, ...changes } = input
      const snapshotChanged = Object.values(changes).some((value) => value !== undefined)
      if (snapshotChanged && agreement.status !== "draft")
        return yield* new InvalidState({
          code: "not_draft",
          message: "Offer fields can only be edited while the agreement is a draft",
        })
      if (status !== undefined) {
        yield* requireFulfillment(agreement, existing)
        if (!["planned", "delivered", "accepted"].includes(existing.status))
          return yield* new InvalidState({
            code: "invalid_transition",
            message: "Only planned, delivered or accepted work can move to in progress",
          })
        if (existing.status !== "planned") yield* requireUnbilled(existing)
      }
      const data: Parameters<typeof db.deliverable.update>[0]["data"] = {}
      if (snapshotChanged) {
        const index = agreement.deliverables.findIndex((line) => line.id === id)
        const lines = agreement.deliverables.map((line) =>
          lineInput(line, agreement.pricesIncludeTax),
        )
        lines[index] = { ...lines[index]!, ...changes, quantity: String(changes.quantity ?? lines[index]!.quantity), unitPrice: String(changes.unitPrice ?? lines[index]!.unitPrice) }
        const priced = priceAgreement({
          profile: resolveCountryProfile(agreement.countryCode),
          deliverables: lines,
          taxRate: agreement.taxRate.toNumber(),
          pricesIncludeTax: agreement.pricesIncludeTax,
          currency: agreement.currency,
        })
        Object.assign(data, priced.deliverableRows[index]!)
        yield* Effect.promise(() =>
          db.agreement.update({
            where: { id: agreement.id },
            data: {
              subtotalNet: priced.subtotalNet,
              totalTax: priced.totalTax,
              totalGross: priced.totalGross,
            },
          }),
        )
      }
      if (expectedDate !== undefined)
        data.expectedDate = expectedDate ? new Date(expectedDate) : null
      if (status !== undefined) Object.assign(data, { status, ...clearedAcceptance })
      const line = yield* Effect.promise(() => db.deliverable.update({ where: { id }, data }))
      command.emit({
        aggregateType: "agreement",
        aggregateId: agreement.id,
        type: "deliverable.updated",
        payload: {
          deliverableId: id,
          fields: Object.keys(input).filter((key) => key !== "id" && key !== "agreementId"),
          previousStatus: existing.status,
          status: line.status,
          deliveryRevision: line.deliveryRevision,
          ...(status !== undefined ? { previousAcceptance: acceptanceRecord(existing) } : {}),
        },
      })
      return line
    }),
})

export const agreementCommands = [
  ...agreementLifecycleCommands,
  ...deliverableCommands,
  createAgreementDraft,
  updateAgreementDraft,
  deleteAgreementDraft,
  updateDeliverable,
] as const
