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
import { mintAgreementLink } from "../../lib/agreements/tokens"
import { readEmailDelivery } from "../email-delivery-result"
import {
  agreementCreateDraftInputSchema,
  agreementUpdateDraftInputSchema,
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
  capabilities: authorizedProcedure("agreement:read").query(({ ctx }) => ({
    send: actorCan(ctx.actor, "agreement:send"),
    update: actorCan(ctx.actor, "agreement:update"),
    accept: actorCan(ctx.actor, "agreement:accept"),
    close: actorCan(ctx.actor, "agreement:close"),
    delete: actorCan(ctx.actor, "agreement:delete"),
  })),
  send: authorizedProcedure("agreement:send")
    .input(agreementIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      const result = unwrapOutcome(await executeCommand(sendAgreement, input, { actor: ctx.actor }))
      await readEmailDelivery(result.deliveryKey, "agreement")
      return serializeAgreementDetail(await getAgreement(ctx.organizationId, input.id))
    }),
  issue: authorizedProcedure("agreement:send")
    .input(agreementIssueInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeAgreementDetail(
        unwrapOutcome(await executeCommand(issueAgreement, input, { actor: ctx.actor })),
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
        unwrapOutcome(await executeCommand(recordAgreementAcceptance, input, { actor: ctx.actor })),
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
        unwrapOutcome(await executeCommand(revokeAgreementLinks, input, { actor: ctx.actor })),
      ),
    ),
  sendReadLink: authorizedProcedure("agreement:send")
    .input(agreementIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      const result = unwrapOutcome(
        await executeCommand(sendAgreementReadLink, input, { actor: ctx.actor }),
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
    .input(agreementCreateDraftInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeAgreementDetail(
        unwrapOutcome(await executeCommand(createAgreementDraft, input, { actor: ctx.actor })),
      ),
    ),
  updateDraft: authorizedProcedure("agreement:update")
    .input(agreementUpdateDraftInputSchema)
    .mutation(async ({ ctx, input }) =>
      serializeAgreementDetail(
        unwrapOutcome(await executeCommand(updateAgreementDraft, input, { actor: ctx.actor })),
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
  listTemplates: authorizedProcedure("agreement:read").query(({ ctx }) =>
    listAgreementTemplates(ctx.organizationId),
  ),
})
