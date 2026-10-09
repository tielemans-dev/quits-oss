import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { actorCan } from "../../domain/actor"
import { DOCUMENT_READ_PERMISSION } from "../../domain/documents/read-permission"
import { documentActivity, listActivity } from "../../lib/exports/activity"
import { authorizedProcedure, orgProcedure, router } from "../init"

const sequenceSchema = z.number().int().nonnegative()

export const activityRouter = router({
  /** The organization audit log. Oldest first after `afterSequence`, or newest first. */
  list: authorizedProcedure("audit:read")
    .input(
      z.object({
        afterSequence: sequenceSchema.optional(),
        beforeSequence: sequenceSchema.optional(),
        order: z.enum(["asc", "desc"]).default("asc"),
        aggregateType: z.string().trim().min(1).max(60).optional(),
        aggregateId: z.string().trim().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
    )
    .query(({ ctx, input }) => listActivity({ organizationId: ctx.organizationId, ...input })),

  /** The activity timeline of one document, readable by anyone who can read the document. */
  forDocument: orgProcedure
    .input(
      z.object({
        aggregateType: z.enum(["invoice", "quote", "creditNote", "agreement"]),
        aggregateId: z.string().trim().min(1).max(100),
      })
    )
    .query(({ ctx, input }) => {
      const permission = DOCUMENT_READ_PERMISSION[input.aggregateType]
      if (!actorCan(ctx.actor, permission)) {
        throw new TRPCError({ code: "FORBIDDEN", message: `Your role does not allow ${permission}` })
      }
      return documentActivity({
        organizationId: ctx.organizationId,
        documentType: input.aggregateType,
        documentId: input.aggregateId,
      })
    }),
})
