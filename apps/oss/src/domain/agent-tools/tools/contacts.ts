import { contactCreateInputSchema, contactUpdateInputSchema } from "@yaip/contracts/contacts"
import { contactsListToolInputSchema, documentIdToolInputSchema } from "@yaip/contracts/agent"
import { prisma } from "../../../lib/db"
import { createContact, updateContact } from "../../commands/contacts"
import { NotFound } from "../../errors"
import { defineCommandTool, defineQueryTool, type AgentTool } from "../define"

export const contactTools: AgentTool[] = [
  defineQueryTool({
    name: "contacts_list",
    title: "List contacts",
    description:
      "Lists customers, alphabetically. Search by name, email, or company before creating a contact " +
      "so you do not create duplicates.",
    input: contactsListToolInputSchema,
    permission: "contact:read",
    run: async ({ actor }, input) => {
      const search = input.search?.trim()
      return prisma.contact.findMany({
        where: {
          organizationId: actor.organizationId,
          ...(search
            ? {
                OR: [
                  { name: { contains: search, mode: "insensitive" } },
                  { email: { contains: search, mode: "insensitive" } },
                  { company: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: { name: "asc" },
        take: input.limit,
      })
    },
  }),

  defineQueryTool({
    name: "contact_get",
    title: "Get contact",
    description: "Returns one contact by id, including address, tax id, and Peppol endpoint.",
    input: documentIdToolInputSchema,
    permission: "contact:read",
    run: async ({ actor }, input) => {
      const contact = await prisma.contact.findFirst({
        where: { id: input.id, organizationId: actor.organizationId },
        include: { taxIds: true },
      })
      if (!contact) {
        throw new NotFound({ message: "Contact not found", entity: "contact", id: input.id })
      }
      return contact
    },
  }),

  defineCommandTool({
    name: "contact_create",
    title: "Create contact",
    description:
      "Creates a customer. Country is a two-letter code; phone, postal code, and tax id are validated " +
      "for that country. The created contact is in result.",
    command: createContact,
    input: contactCreateInputSchema,
  }),

  defineCommandTool({
    name: "contact_update",
    title: "Update contact",
    description: "Updates the given fields of a contact; omitted fields stay unchanged.",
    command: updateContact,
    input: contactUpdateInputSchema,
  }),
]
