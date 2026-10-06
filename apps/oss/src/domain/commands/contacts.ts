import { Effect } from "effect"
import {
  contactCreateInputSchema,
  contactDeleteInputSchema,
  contactUpdateInputSchema,
} from "@yaip/contracts/contacts"
import {
  getCountryCodeOrFallback,
  validateLocalizedFields,
} from "../../lib/validation/localization"
import { defineCommand } from "../command"
import { InvalidState, NotFound, ValidationFailed } from "../errors"
import { Command, Db } from "../services"

function normalizeCountry(country: string | undefined) {
  return country?.trim().length === 2 ? country.toUpperCase() : country || null
}

function validateLocalized(
  countryCode: string,
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
  input: contactCreateInputSchema,
  summarize: (input) => `Create contact ${input.name}`,
  handle: (input) =>
    Effect.gen(function* () {
      const db = yield* Db
      const command = yield* Command
      const orgCountry = yield* loadOrgCountry

      yield* validateLocalized(
        getCountryCodeOrFallback(
          (input.country?.trim().length === 2 ? input.country : undefined) || orgCountry
        ),
        input
      )

      const contact = yield* Effect.promise(() =>
        db.contact.create({
          data: {
            ...input,
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
      return contact
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
          select: { phone: true, zip: true, taxId: true, country: true },
        })
      )
      if (!existing) {
        return yield* new NotFound({ message: "Contact not found", entity: "contact", id: input.id })
      }

      const orgCountry = yield* loadOrgCountry
      yield* validateLocalized(
        getCountryCodeOrFallback(
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
            _count: { select: { invoices: true, quotes: true, creditNotes: true, recurringInvoices: true } },
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

export const contactCommands = [createContact, updateContact, deleteContact] as const
