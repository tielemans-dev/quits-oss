import { createAgreementTemplate, updateAgreementTemplate, deleteAgreementTemplate } from "../../domain/commands/agreement-templates"
import { agreementTemplateCreateInputSchema, agreementTemplateUpdateInputSchema } from "@quits/contracts/agreements"
import { executeIssuanceCommand } from "../../application/issuance"
import {
  markDeliverableDelivered,
  acceptDeliverable,
  cancelDeliverable,
} from "../../domain/commands/deliverables"
import { deliverableIdInputSchema, deliverableAcceptInputSchema } from "@quits/contracts/agreements"
import { actorCan } from "../../domain/actor"
import {
  sendAgreement,
  issueAgreement,
  resendAgreement,
  recallAgreement,
  recordAgreementAcceptance,
  closeAgreement,
  revokeAgreementLinks,
  sendAgreementReadLink,
} from "../../domain/commands/agreement-lifecycle"
import {
  agreementIssueInputSchema,
  agreementResendInputSchema,
  agreementRecordAcceptanceInputSchema,
  agreementCloseInputSchema,
} from "@quits/contracts/agreements"
import { mintAgreementLink, mintDeliverableSignOffLink } from "../../lib/agreements/tokens"
import { readEmailDelivery } from "../email-delivery-result"
import {
  agreementCreateDraftRequestSchema,
  agreementCreateDraftDecimalRequestSchema,
  agreementUpdateDraftInputSchema,
  agreementUpdateDraftDecimalInputSchema,
  agreementIdInputSchema,
  agreementListInputSchema,
  deliverableUpdateInputSchema,
} from "@quits/contracts/agreements"
import {
  createAgreementDraft,
  updateAgreementDraft,
  deleteAgreementDraft,
  updateDeliverable,
} from "../../domain/commands/agreements"
import {
  listAgreements,
  getAgreement,
  serializeAgreement,
  serializeAgreementDetail,
  serializeDeliverable,
} from "../../domain/agreements/queries"
import { listAgreementTemplates } from "../../domain/agreements/templates"
import { executeCommand } from "../../domain/execute"
import { router, authorizedProcedure } from "../init"
import { unwrapOutcome } from "../outcome"

export const agreementsRouter = router({
  createTemplate: authorizedProcedure("agreement:manageTemplates").input(agreementTemplateCreateInputSchema)
    .mutation(async ({ ctx, input }) => unwrapOutcome(await executeCommand(createAgreementTemplate, input, { actor: ctx.actor }))),
  updateTemplate: authorizedProcedure("agreement:manageTemplates").input(agreementTemplateUpdateInputSchema)
    .mutation(async ({ ctx, input }) => unwrapOutcome(await executeCommand(updateAgreementTemplate, input, { actor: ctx.actor }))),
  deleteTemplate: authorizedProcedure("agreement:manageTemplates").input(agreementIdInputSchema)
    .mutation(async ({ ctx, input }) => unwrapOutcome(await executeCommand(deleteAgreementTemplate, input, { actor: ctx.actor }))),
  capabilities: authorizedProcedure("agreement:read").query(({ ctx }) => ({
    manageTemplates: actorCan(ctx.actor, "agreement:manageTemplates"),
    invoice: actorCan(ctx.actor, "invoice:create"),
    send: actorCan(ctx.actor, "agreement:send"),
    update: actorCan(ctx.actor, "agreement:update"),
    accept: actorCan(ctx.actor, "agreement:accept"),
    close: actorCan(ctx.actor, "agreement:close"),
    delete: actorCan(ctx.actor, "agreement:delete"),
    deliverableUpdate: actorCan(ctx.actor, "deliverable:update"),
    deliverableDeliver: actorCan(ctx.actor, "deliverable:deliver"),
    deliverableAccept: actorCan(ctx.actor, "deliverable:accept"),
  })),
  send: authorizedProcedure("agreement:send")
    .input(agreementIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      const result = unwrapOutcome(await executeIssuanceCommand(sendAgreement, input, { actor: ctx.actor }))
      await readEmailDelivery(result.deliveryKey, "agreement")
      return serializeAgreementDetail(await getAgreement(ctx.organizationId, input.id))
    }),
  issue: authorizedProcedure("agreement:send")
    .input(agreementIssueInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeAgreementDetail(
        unwrapOutcome(await executeIssuanceCommand(issueAgreement, input, { actor: ctx.actor })),
      ),
    ),
  resend: authorizedProcedure("agreement:send")
    .input(agreementResendInputSchema)
    .mutation(async ({ ctx, input }) => {
      const result = unwrapOutcome(
        await executeCommand(resendAgreement, input, { actor: ctx.actor }),
      )
      await readEmailDelivery(result.deliveryKey, "agreement")
      return serializeAgreementDetail(await getAgreement(ctx.organizationId, input.id))
    }),
  recall: authorizedProcedure("agreement:update")
    .input(agreementIdInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeAgreementDetail(
        unwrapOutcome(await executeCommand(recallAgreement, input, { actor: ctx.actor })),
      ),
    ),
  recordAcceptance: authorizedProcedure("agreement:accept")
    .input(agreementRecordAcceptanceInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeAgreementDetail(
        unwrapOutcome(
          await executeCommand(recordAgreementAcceptance, input, {
            actor: ctx.actor,
          }),
        ),
      ),
    ),
  close: authorizedProcedure("agreement:close")
    .input(agreementCloseInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeAgreementDetail(
        unwrapOutcome(await executeCommand(closeAgreement, input, { actor: ctx.actor })),
      ),
    ),
  revokeLinks: authorizedProcedure("agreement:update")
    .input(agreementIdInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeAgreementDetail(
        unwrapOutcome(
          await executeCommand(revokeAgreementLinks, input, {
            actor: ctx.actor,
          }),
        ),
      ),
    ),
  sendReadLink: authorizedProcedure("agreement:send")
    .input(agreementIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      const result = unwrapOutcome(
        await executeCommand(sendAgreementReadLink, input, {
          actor: ctx.actor,
        }),
      )
      await readEmailDelivery(result.deliveryKey, "agreement")
      return serializeAgreementDetail(await getAgreement(ctx.organizationId, input.id))
    }),
  publicLink: authorizedProcedure("agreement:read")
    .input(agreementIdInputSchema)
    .query(async ({ ctx, input }) => {
      const agreement = await getAgreement(ctx.organizationId, input.id)
      if (agreement.acceptedAt && ["accepted", "completed", "cancelled"].includes(agreement.status))
        return mintAgreementLink(agreement, "read", new Date())
      if (agreement.status === "sent" && agreement.expiresAt && new Date() < agreement.expiresAt)
        return mintAgreementLink(agreement, "decide", new Date())
      return null
    }),
  list: authorizedProcedure("agreement:read")
    .input(agreementListInputSchema.optional())
    .query(async ({ ctx, input }) =>
      (await listAgreements(ctx.organizationId, input)).map(serializeAgreement),
    ),
  get: authorizedProcedure("agreement:read")
    .input(agreementIdInputSchema)
    .query(async ({ ctx, input }) =>
      serializeAgreementDetail(await getAgreement(ctx.organizationId, input.id)),
    ),
  createDraft: authorizedProcedure("agreement:create")
    .input(agreementCreateDraftRequestSchema)
    .mutation(async ({ ctx, input }) =>
      serializeAgreementDetail(
        unwrapOutcome(
          await executeCommand(createAgreementDraft, input, {
            actor: ctx.actor,
          }),
        ),
      ),
    ),
  createDraftDecimal: authorizedProcedure("agreement:create")
    .input(agreementCreateDraftDecimalRequestSchema)
    .mutation(async ({ ctx, input }) =>
      serializeAgreementDetail(
        unwrapOutcome(
          await executeCommand(createAgreementDraft, input, {
            actor: ctx.actor,
          }),
        ),
      ),
    ),
  updateDraft: authorizedProcedure("agreement:update")
    .input(agreementUpdateDraftInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeAgreementDetail(
        unwrapOutcome(
          await executeCommand(updateAgreementDraft, input, {
            actor: ctx.actor,
          }),
        ),
      ),
    ),
  updateDraftDecimal: authorizedProcedure("agreement:update")
    .input(agreementUpdateDraftDecimalInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeAgreementDetail(
        unwrapOutcome(
          await executeCommand(updateAgreementDraft, input, {
            actor: ctx.actor,
          }),
        ),
      ),
    ),
  deleteDraft: authorizedProcedure("agreement:delete")
    .input(agreementIdInputSchema)
    .mutation(async ({ ctx, input }) =>
      unwrapOutcome(await executeCommand(deleteAgreementDraft, input, { actor: ctx.actor })),
    ),
  updateDeliverable: authorizedProcedure("deliverable:update")
    .input(deliverableUpdateInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeDeliverable(
        unwrapOutcome(await executeCommand(updateDeliverable, input, { actor: ctx.actor })),
      ),
    ),
  deliverablePublicLink: authorizedProcedure("deliverable:read")
    .input(deliverableIdInputSchema)
    .query(async ({ ctx, input }) => {
      const agreement = await getAgreement(ctx.organizationId, input.agreementId)
      const line = agreement.deliverables.find(line => line.id === input.id)
      if (agreement.status !== "accepted" || !line || line.status !== "delivered" || !line.deliveredAt || new Date().getTime() >= line.deliveredAt.getTime() + 90 * 86400_000) return null
      return mintDeliverableSignOffLink(agreement, line)
    }),
  markDeliverableDelivered: authorizedProcedure("deliverable:deliver")
    .input(deliverableIdInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeDeliverable(
        unwrapOutcome(
          await executeCommand(markDeliverableDelivered, input, {
            actor: ctx.actor,
          }),
        ),
      ),
    ),
  acceptDeliverable: authorizedProcedure("deliverable:accept")
    .input(deliverableAcceptInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeDeliverable(
        unwrapOutcome(await executeCommand(acceptDeliverable, input, { actor: ctx.actor })),
      ),
    ),
  cancelDeliverable: authorizedProcedure("deliverable:update")
    .input(deliverableIdInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeDeliverable(
        unwrapOutcome(await executeCommand(cancelDeliverable, input, { actor: ctx.actor })),
      ),
    ),
  listTemplates: authorizedProcedure("agreement:read").query(({ ctx }) =>
    listAgreementTemplates(ctx.organizationId),
  ),
})
