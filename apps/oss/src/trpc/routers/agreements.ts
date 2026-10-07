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
