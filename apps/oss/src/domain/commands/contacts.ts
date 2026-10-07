import { Effect } from "effect"
import {
  contactCreateInputSchema,
  contactDeleteInputSchema,
  contactUpdateInputSchema,
  PEPPOL_ENDPOINT_ID_MESSAGE,
  PEPPOL_ENDPOINT_PAIR_MESSAGE,
} from "@quits/contracts/contacts"
import { peppolEndpointIssue } from "@quits/contracts/exports"
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
      yield* validatePeppolEndpoint({
        id: input.peppolEndpointId ?? null,
        scheme: input.peppolEndpointScheme ?? null,
      })

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
            _count: { select: { invoices: true, quotes: true, creditNotes: true, recurringInvoices: true, agreements: true } },
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
