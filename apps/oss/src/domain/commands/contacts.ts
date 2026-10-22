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
  storedPhone,
  validateLocalizedFields,
} from "../../lib/validation/localization"
import { defineCommand } from "../command"
import { actorId } from "../actor"
import { fingerprint } from "../approval-contexts"
import { lockDocument } from "../documents/locks"
import { InvalidState, NotFound, ValidationFailed } from "../errors"
import { Command, Db } from "../services"
import { cvrDigits, registryFactsSchema, registryName, type RegistryFacts } from "../../lib/contacts/registry"

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

/**
 * A customer from a CVR lookup takes its CVR number and name from the register: the legal name, or a
 * secondary name (binavn) the register lists. Its billing address is the registered address unless it has one of its own.
 */
function registryContactFields(registry: RegistryFacts, ownBilling: boolean, wantedName?: string | null) {
  const registered = { address: registry.address || null, zip: registry.zip || null, city: registry.city || null }
  return {
    registrySource: "cvr",
    taxId: registry.cvr,
    company: registryName(registry, wantedName),
    legalName: registry.legalName,
    registrySecondaryNames: registry.secondaryNames,
    registeredAddress: registered.address,
    registeredZip: registered.zip,
    registeredCity: registered.city,
    ...(ownBilling ? {} : { ...registered, country: "DK" }),
  }
}

/** A CVR customer's number and name follow the register; another number means a new lookup. */
function validateRegistryIdentity(
  existing: { taxId: string | null; company: string | null; legalName: string | null; registrySecondaryNames: string[] },
  input: { taxId?: string; company?: string }
) {
  const issues = [
    ...(input.taxId !== undefined && cvrDigits(input.taxId) !== cvrDigits(existing.taxId)
      ? [{ path: "taxId", message: "The CVR number comes from the register. Look up the new number as a new customer." }]
      : []),
    ...(input.company !== undefined && input.company !== existing.company && input.company !== existing.legalName && !existing.registrySecondaryNames.includes(input.company)
      ? [{ path: "company", message: "The name comes from the register: its legal name or one of its secondary names. Update the customer from CVR to refresh them." }]
      : []),
  ]
  return issues.length
    ? Effect.fail(new ValidationFailed({ message: issues.map(issue => issue.message).join(" "), issues }))
    : Effect.void
}

const loadOrgCountry = Effect.gen(function* () {
  const db = yield* Db
  const { organizationId } = yield* Command
  const settings = yield* Effect.promise(() =>
    db.orgSettings.findUnique({ where: { organizationId }, select: { countryCode: true } })
  )
  return settings?.countryCode
})

const contactCreateCommandInputSchema = contactCreateInputSchema.and(z.object({ reuseCvr: z.boolean().optional() }))
type ContactCreateCommandInput = z.infer<typeof contactCreateCommandInputSchema>

function createContactWith(input: ContactCreateCommandInput, registry?: RegistryFacts) {
  return Effect.gen(function* () {
    const db = yield* Db
    const command = yield* Command
    // Commands already hold the organization lock, so concurrent CVR requests reuse one customer.
    const { reuseCvr, ...given } = input
    const fields = registry ? { ...given, ...registryContactFields(registry, Boolean(given.address || given.zip || given.city), given.company), registryCheckedAt: command.now } : given
    if (reuseCvr && fields.country === "DK" && /^\d{8}$/.test(fields.taxId ?? "")) {
      const contacts = yield* Effect.promise(() => db.contact.findMany({ where: { organizationId: command.organizationId, taxId: { not: null } } }))
      const existing = contacts.find(contact => contact.taxId?.replace(/^DK\s*/i, "").replace(/\s/g, "") === fields.taxId)
      if (existing) return { ...existing, reused: true }
    }
    const orgCountry = yield* loadOrgCountry

    const countryCode = normalizeCountryCode(
      (fields.country?.trim().length === 2 ? fields.country : undefined) || orgCountry
    )
    yield* validateLocalized(countryCode, fields)
    yield* validatePeppolEndpoint({
      id: fields.peppolEndpointId ?? null,
      scheme: fields.peppolEndpointScheme ?? null,
    })

    const contact = yield* Effect.promise(() =>
      db.contact.create({
        data: {
          ...fields,
          ...(fields.phone !== undefined ? { phone: storedPhone(fields.phone, countryCode) } : {}),
          email: fields.email || null,
          country: normalizeCountry(fields.country ?? undefined),
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
  })
}

export const createContact = defineCommand({
  type: "contact.create",
  permission: "contact:create",
  outwardFacing: false,
  input: contactCreateCommandInputSchema,
  summarize: (input) => `Create contact ${input.name}`,
  handle: (input) => createContactWith(input),
})

/**
 * `contact.create` for a customer from the CVR register, with the facts the server looked up itself.
 * It is kept out of `allCommands`, so an approved agent request can never dispatch made-up facts.
 */
export const createContactFromRegistry = defineCommand({
  ...createContact,
  input: contactCreateCommandInputSchema.and(z.object({ registry: registryFactsSchema })),
  handle: ({ registry, ...input }) => createContactWith(input, registry),
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
            registrySource: true,
            company: true,
            legalName: true,
            registrySecondaryNames: true,
          },
        })
      )
      if (!existing) {
        return yield* new NotFound({ message: "Contact not found", entity: "contact", id: input.id })
      }
      if (existing.registrySource === "cvr") yield* validateRegistryIdentity(existing, input)

      const orgCountry = yield* loadOrgCountry
      const countryCode = normalizeCountryCode(
        (input.country?.trim().length === 2 ? input.country : undefined) ||
          (existing.country?.trim().length === 2 ? existing.country : undefined) ||
          orgCountry
      )
      yield* validateLocalized(countryCode,
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
            ...(data.phone !== undefined ? { phone: storedPhone(data.phone, countryCode) } : {}),
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

/**
 * Refreshes a customer's CVR number, legal name and registered address from the register, with facts
 * the server looked up for the customer's stored CVR. A manual Danish customer becomes a CVR customer.
 * Like `createContactFromRegistry`, it is kept out of `allCommands`.
 */
export const refreshContactFromRegistry = defineCommand({
  type: "contact.registry_refresh",
  permission: "contact:update",
  outwardFacing: false,
  input: z.object({ id: z.string().min(1), registry: registryFactsSchema }),
  summarize: (input) => `Update contact ${input.id} from CVR`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const existing = yield* Effect.promise(() =>
        db.contact.findFirst({ where: { id: input.id, organizationId: command.organizationId } })
      )
      if (!existing) {
        return yield* new NotFound({ message: "Contact not found", entity: "contact", id: input.id })
      }
      if (cvrDigits(existing.taxId) !== input.registry.cvr) {
        return yield* new InvalidState({ code: "registry_cvr_mismatch", message: "The register answered for a different CVR number" })
      }
      // A billing address that still follows the registered one moves with it; one of its own stays.
      const followsRegistered = existing.registrySource === "cvr"
        ? existing.address === existing.registeredAddress && existing.zip === existing.registeredZip && existing.city === existing.registeredCity
        : !existing.address && !existing.zip && !existing.city
      const contact = yield* Effect.promise(() =>
        db.contact.update({
          where: { id: existing.id, organizationId: command.organizationId },
          data: { ...registryContactFields(input.registry, !followsRegistered, existing.company), registryCheckedAt: command.now },
        })
      )
      command.emit({
        aggregateType: "contact",
        aggregateId: contact.id,
        type: "contact.updated",
        payload: { fields: ["registry"] },
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
