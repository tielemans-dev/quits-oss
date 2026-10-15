import { Effect } from "effect"
import { z } from "zod"
import { normalizeReminderRecipient } from "../../lib/reminders/unsubscribe-token"
import {
  contactCreateInputSchema,
  contactDeleteInputSchema,
  contactUpdateInputSchema,
  PEPPOL_ENDPOINT_ID_MESSAGE,
  PEPPOL_ENDPOINT_PAIR_MESSAGE,
} from "@quits/contracts/contacts"
import { peppolEndpointIssue } from "@quits/contracts/exports"
import {
  normalizeCountryCode,
  validateLocalizedFields,
} from "../../lib/validation/localization"
import { defineCommand } from "../command"
import { actorId } from "../actor"
import { fingerprint } from "../approval-contexts"
import { lockDocument } from "../documents/locks"
import { InvalidState, NotFound, ValidationFailed } from "../errors"
import { Command, Db } from "../services"

function normalizeCountry(country: string | undefined) {
  return country?.trim().length === 2 ? country.toUpperCase() : country || null
}

function validateLocalized(
  countryCode: string | null,
  fields: { phone?: string | null; zip?: string | null; taxId?: string | null }
) {
  const issues = validateLocalizedFields(countryCode, {
    phone: fields.phone ?? undefined,
    postalCode: fields.zip ?? undefined,
    taxId: fields.taxId ?? undefined,
  })
  const messages = Object.entries(issues).filter(
    (entry): entry is [string, string] => Boolean(entry[1])
  )
  if (messages.length === 0) {
    return Effect.void
  }

  return Effect.fail(
    new ValidationFailed({
      message: messages.map(([, message]) => message).join(" "),
      issues: messages.map(([path, message]) => ({ path, message })),
    })
  )
}

/**
 * Checks the Peppol endpoint a contact will have after the change: both parts or neither, and an
 * identifier that fits its EAS scheme. Partial updates are merged with the stored values first.
 */
function validatePeppolEndpoint(endpoint: { id: string | null; scheme: string | null }) {
  const path = endpoint.id ? "peppolEndpointScheme" : "peppolEndpointId"
  if (!endpoint.id !== !endpoint.scheme) {
    return Effect.fail(
      new ValidationFailed({
        message: PEPPOL_ENDPOINT_PAIR_MESSAGE,
        issues: [{ path, message: PEPPOL_ENDPOINT_PAIR_MESSAGE }],
      })
    )
  }
  const issue = endpoint.id && endpoint.scheme ? peppolEndpointIssue(endpoint.scheme, endpoint.id) : null
  if (issue) {
    const message = issue === "scheme" ? "Use a Peppol EAS code from the Peppol code list" : PEPPOL_ENDPOINT_ID_MESSAGE
    const issuePath = issue === "scheme" ? "peppolEndpointScheme" : "peppolEndpointId"
    return Effect.fail(new ValidationFailed({ message, issues: [{ path: issuePath, message }] }))
  }
  return Effect.void
}

const loadOrgCountry = Effect.gen(function* () {
  const db = yield* Db
  const { organizationId } = yield* Command
  const settings = yield* Effect.promise(() =>
    db.orgSettings.findUnique({ where: { organizationId }, select: { countryCode: true } })
  )
  return settings?.countryCode
})

export const createContact = defineCommand({
  type: "contact.create",
  permission: "contact:create",
  outwardFacing: false,
  input: contactCreateInputSchema.and(z.object({ reuseCvr: z.boolean().optional() })),
  summarize: (input) => `Create contact ${input.name}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      // Commands already hold the organization lock, so concurrent CVR requests reuse one customer.
      const { reuseCvr, ...fields } = input
      if (reuseCvr && input.country === "DK" && /^\d{8}$/.test(input.taxId ?? "")) {
        const contacts = yield* Effect.promise(() => db.contact.findMany({ where: { organizationId: command.organizationId, taxId: { not: null } } }))
        const existing = contacts.find(contact => contact.taxId?.replace(/^DK\s*/i, "").replace(/\s/g, "") === input.taxId)
        if (existing) return { ...existing, reused: true }
      }
      const orgCountry = yield* loadOrgCountry

      yield* validateLocalized(
        normalizeCountryCode(
          (input.country?.trim().length === 2 ? input.country : undefined) || orgCountry
        ),
        input
      )
      yield* validatePeppolEndpoint({
        id: input.peppolEndpointId ?? null,
        scheme: input.peppolEndpointScheme ?? null,
      })

      const contact = yield* Effect.promise(() =>
        db.contact.create({
          data: {
            ...fields,
            email: input.email || null,
            country: normalizeCountry(input.country),
            organizationId: command.organizationId,
          },
        })
      )

      command.emit({
        aggregateType: "contact",
        aggregateId: contact.id,
        type: "contact.created",
        payload: { name: contact.name },
      })
      return { ...contact, reused: false }
    }),
})

export const updateContact = defineCommand({
  type: "contact.update",
  permission: "contact:update",
  outwardFacing: false,
  input: contactUpdateInputSchema,
  summarize: (input) => `Update contact ${input.name ?? input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const existing = yield* Effect.promise(() =>
        db.contact.findFirst({
          where: { id: input.id, organizationId: command.organizationId },
          select: {
            phone: true,
            zip: true,
            taxId: true,
            country: true,
            peppolEndpointId: true,
            peppolEndpointScheme: true,
          },
        })
      )
      if (!existing) {
        return yield* new NotFound({ message: "Contact not found", entity: "contact", id: input.id })
      }

      const orgCountry = yield* loadOrgCountry
      yield* validateLocalized(
        normalizeCountryCode(
          (input.country?.trim().length === 2 ? input.country : undefined) ||
            (existing.country?.trim().length === 2 ? existing.country : undefined) ||
            orgCountry
        ),
        {
          phone: input.phone ?? existing.phone,
          zip: input.zip ?? existing.zip,
          taxId: input.taxId ?? existing.taxId,
        }
      )
      yield* validatePeppolEndpoint({
        id: input.peppolEndpointId !== undefined ? input.peppolEndpointId : existing.peppolEndpointId,
        scheme:
          input.peppolEndpointScheme !== undefined ? input.peppolEndpointScheme : existing.peppolEndpointScheme,
      })

      const { id, ...data } = input
      const contact = yield* Effect.promise(() =>
        db.contact.update({
          where: { id, organizationId: command.organizationId },
          data: {
            ...data,
            ...(data.email !== undefined ? { email: data.email || null } : {}),
            ...(data.country !== undefined ? { country: normalizeCountry(data.country) } : {}),
          },
        })
      )

      command.emit({
        aggregateType: "contact",
        aggregateId: contact.id,
        type: "contact.updated",
        payload: { fields: Object.keys(data) },
      })
      return contact
    }),
})

export const deleteContact = defineCommand({
  type: "contact.delete",
  permission: "contact:delete",
  outwardFacing: false,
  input: contactDeleteInputSchema,
  summarize: (input) => `Delete contact ${input.id}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const contact = yield* Effect.promise(() =>
        db.contact.findFirst({
          where: { id: input.id, organizationId: command.organizationId },
          select: {
            id: true,
            name: true,
            _count: { select: { invoices: true, quotes: true, creditNotes: true, recurringInvoices: true, agreements: true, settlementReceipts: true } },
          },
        })
      )
      if (!contact) {
        return yield* new NotFound({ message: "Contact not found", entity: "contact", id: input.id })
      }

      const documentCount = Object.values(contact._count).reduce((sum, count) => sum + count, 0)
      if (documentCount > 0) {
        return yield* new InvalidState({
          message: "This contact has documents and cannot be deleted",
          code: "contact_in_use",
        })
      }

      yield* Effect.promise(() => db.contact.delete({ where: { id: contact.id } }))
      command.emit({
        aggregateType: "contact",
        aggregateId: contact.id,
        type: "contact.deleted",
        payload: { name: contact.name },
      })
      return { id: contact.id }
    }),
})

const reminderResumeTarget = (id: string) => Effect.gen(function* () {
  const db = yield* Db
  const command = yield* Command
  yield* lockDocument("contact", id, { strength: "no_key_update" })
  const contact = yield* Effect.promise(() => db.contact.findFirst({ where: { id, organizationId: command.organizationId } }))
  if (!contact) return yield* new NotFound({ message: "Contact not found", entity: "contact", id })
  if (!contact.email) return yield* new InvalidState({ message: "Contact has no email address", code: "contact_email_missing" })
  return { contact, recipient: normalizeReminderRecipient(contact.email) }
})

export const resumeContactReminders = defineCommand({
  type: "contact.reminders.resume",
  permission: "invoice:send",
  outwardFacing: true,
  input: z.object({ id: z.string() }),
  summarize: (input) => `Resume automatic reminders for contact ${input.id}`,
  approvalContext: (input) => Effect.gen(function* () {
    const { contact, recipient } = yield* reminderResumeTarget(input.id)
    return {
      summary: `Resume automatic payment reminders for ${contact.name} to ${recipient}`,
      version: fingerprint([contact.id, contact.name, recipient]),
      details: { customer: contact.name, recipient },
    }
  }),
  handle: (input) => Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    const { contact, recipient } = yield* reminderResumeTarget(input.id)
    const updated = yield* Effect.promise(() => db.recipientReminderPreference.updateMany({
      where: { organizationId: command.organizationId, recipient, unsubscribedAt: { not: null } },
      data: { unsubscribedAt: null },
    }))
    if (updated.count > 0) {
      command.emit({ aggregateType: "contact", aggregateId: contact.id, type: "contact.updated", payload: { fields: ["reminderUnsubscribedAt"] } })
    }
    return { id: contact.id }
  }),
})

export const undoCreateContact = defineCommand({
  type: "contact.undo_create",
  permission: "contact:create",
  outwardFacing: false,
  input: contactDeleteInputSchema,
  summarize: input => `Undo contact creation ${input.id}`,
  handle: input => Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    const latest = yield* Effect.promise(() => db.domainEvent.findFirst({
      where: { organizationId: command.organizationId, aggregateType: "contact", aggregateId: input.id },
      orderBy: { sequence: "desc" },
    }))
    if (command.actor.kind !== "user" || latest?.type !== "contact.created" || latest.actorKind !== "user" || latest.actorId !== actorId(command.actor) || latest.occurredAt.getTime() < command.now.getTime() - 8000) {
      return yield* new InvalidState({ code: "undo_unavailable", message: "Only your unchanged customer creation can be undone within eight seconds" })
    }
    return yield* deleteContact.handle(input)
  }),
})

export const contactCommands = [createContact, updateContact, deleteContact, resumeContactReminders, undoCreateContact] as const
