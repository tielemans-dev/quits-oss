import { z } from "zod"
import {
  contactCreateInputSchema,
  contactUpdateInputSchema,
} from "@quits/contracts/contacts"
import { createContact, deleteContact, resumeContactReminders, updateContact } from "../../domain/commands/contacts"
import { actorCan } from "../../domain/actor"
import { normalizeReminderRecipient } from "../../lib/reminders/unsubscribe-token"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../../lib/db"
import { router, authorizedProcedure } from "../init"
import { unwrapOutcome } from "../outcome"

export const contactsRouter = router({
  list: authorizedProcedure("contact:read").query(async ({ ctx }) => {
    return prisma.contact.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { name: "asc" },
    })
  }),

  get: authorizedProcedure("contact:read")
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const contact = await prisma.contact.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
      })
      const preference = contact.email ? await prisma.recipientReminderPreference.findUnique({
        where: { organizationId_recipient: { organizationId: ctx.organizationId, recipient: normalizeReminderRecipient(contact.email) } },
        select: { unsubscribedAt: true },
      }) : null
      return { ...contact, reminderUnsubscribedAt: preference?.unsubscribedAt ?? null, canResumeReminders: actorCan(ctx.actor, "invoice:send") }
    }),

  resumeReminders: authorizedProcedure("invoice:send")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(resumeContactReminders, input, { actor: ctx.actor }))
    ),

  create: authorizedProcedure("contact:create")
    .input(contactCreateInputSchema)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(createContact, input, { actor: ctx.actor }))
    ),

  update: authorizedProcedure("contact:update")
    .input(contactUpdateInputSchema)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(updateContact, input, { actor: ctx.actor }))
    ),

  delete: authorizedProcedure("contact:delete")
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(deleteContact, input, { actor: ctx.actor }))
    ),
})
