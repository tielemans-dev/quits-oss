import { contactCreateInputSchema, contactUpdateInputSchema } from "@quits/contracts/contacts"
import { contactsListToolInputSchema, documentIdToolInputSchema } from "@quits/contracts/agent"
import { prisma } from "../../../lib/db"
import { createContact, updateContact } from "../../commands/contacts"
import { NotFound } from "../../errors"
import { defineCommandTool, defineQueryTool, type AgentTool } from "../define"
import { decodeCursor, toPage } from "../pagination"

export const contactTools: AgentTool[] = [
  defineQueryTool({
    name: "contacts_list",
    title: "List contacts",
    description:
      "Lists customers, alphabetically. Search by name, email, or company before creating a contact " +
      "so you do not create duplicates. Returns { items, nextCursor }; pass nextCursor for the next page.",
    input: contactsListToolInputSchema,
    permission: "contact:read",
    run: async ({ actor }, input) => {
      const search = input.search?.trim()
      const cursor = decodeCursor(input.cursor)
      const contacts = await prisma.contact.findMany({
        where: {
          organizationId: actor.organizationId,
          AND: [
            cursor
              ? { OR: [{ name: { gt: cursor.key } }, { name: cursor.key, id: { gt: cursor.id } }] }
              : {},
            search
              ? {
                  OR: [
                    { name: { contains: search, mode: "insensitive" } },
                    { email: { contains: search, mode: "insensitive" } },
                    { company: { contains: search, mode: "insensitive" } },
                  ],
                }
              : {},
          ],
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: input.limit + 1,
      })
      return toPage(contacts, input.limit, (contact) => contact.name)
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
