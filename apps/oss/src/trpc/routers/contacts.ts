import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { isValidDanishCvr } from "@quits/contracts/onboarding"
import {
  contactCreateInputSchema,
  contactUpdateInputSchema,
} from "@quits/contracts/contacts"
import { createContact, createContactFromRegistry, deleteContact, refreshContactFromRegistry, resumeContactReminders, updateContact, undoCreateContact } from "../../domain/commands/contacts"
import { cvrDigits, registryFacts } from "../../lib/contacts/registry"
import { getCvrLookupProvider } from "../../lib/runtime/services"
import type { Context } from "../init"
import { lookupSignal } from "./cvr"
import { actorCan } from "../../domain/actor"
import { normalizeReminderRecipient } from "../../lib/reminders/unsubscribe-token"
import { executeCommand } from "../../domain/execute"
import { prisma } from "../../lib/db"
import { router, authorizedProcedure } from "../init"
import { unwrapOutcome } from "../outcome"

/** The register's facts for `cvr`, looked up here so a client cannot supply a customer's legal identity. */
async function lookupRegistry(ctx: { user: { id: string }; organizationId: string; request?: Context["request"] }, cvr: string, signal?: AbortSignal) {
  const lookup = getCvrLookupProvider()
  if (!lookup) throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "CVR lookup is unavailable" })
  const company = await lookup.get(cvr, { userId: ctx.user.id, organizationId: ctx.organizationId, signal: lookupSignal(signal, ctx.request?.signal) })
  if (!company || company.cvr !== cvr) throw new TRPCError({ code: "NOT_FOUND", message: "The CVR register has no company with this number" })
  return registryFacts(company)
}

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
      const contact = await prisma.contact.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      })
      if (!contact) throw new TRPCError({ code: "NOT_FOUND" })
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

  // `registryCvr` creates a CVR customer from the register's answer for that number.
  create: authorizedProcedure("contact:create")
    .input(contactCreateInputSchema.and(z.object({ reuseCvr: z.boolean().optional(), registryCvr: z.string().regex(/^\d{8}$/).optional() })))
    .mutation(async ({ ctx, input, signal }) => {
      const { registryCvr, ...fields } = input
      if (!registryCvr) return unwrapOutcome(await executeCommand(createContact, fields, { actor: ctx.actor }))
      const registry = await lookupRegistry(ctx, registryCvr, signal)
      return unwrapOutcome(await executeCommand(createContactFromRegistry, { ...fields, registry }, { actor: ctx.actor }))
    }),

  refreshFromCvr: authorizedProcedure("contact:update")
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input, signal }) => {
      const contact = await prisma.contact.findFirst({ where: { id: input.id, organizationId: ctx.organizationId }, select: { taxId: true } })
      if (!contact) throw new TRPCError({ code: "NOT_FOUND" })
      const cvr = cvrDigits(contact.taxId)
      if (!isValidDanishCvr(cvr)) throw new TRPCError({ code: "BAD_REQUEST", message: "This customer has no Danish CVR number" })
      const registry = await lookupRegistry(ctx, cvr, signal)
      return unwrapOutcome(await executeCommand(refreshContactFromRegistry, { id: input.id, registry }, { actor: ctx.actor }))
    }),

  undoCreate: authorizedProcedure("contact:create")
    .input(undoCreateContact.input)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(undoCreateContact, input, { actor: ctx.actor }))
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
