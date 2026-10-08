import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { decideConsent, describeConsentRequest, getMcpOAuthContext } from "../../domain/agent-oauth/server"
import { orgProcedure, router } from "../init"
import { rethrowDomainError } from "../outcome"

const requestIdSchema = z.string().trim().min(1).max(200)

function requireContext() {
  const context = getMcpOAuthContext()
  if (!context) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Connecting AI apps by signing in is not enabled" })
  }
  return context
}

/** Consent for MCP clients that connect by signing in (prototype, issue #31). */
export const connectorsRouter = router({
  consentRequest: orgProcedure
    .input(z.object({ requestId: requestIdSchema }))
    .query(({ ctx, input }) =>
      describeConsentRequest(requireContext(), ctx.actor, input.requestId).catch(rethrowDomainError)
    ),

  decide: orgProcedure
    .input(
      z.discriminatedUnion("decision", [
        z.object({ requestId: requestIdSchema, decision: z.literal("deny") }),
        z.object({
          requestId: requestIdSchema,
          decision: z.literal("approve"),
          presetId: z.enum(["read_only", "drafting_only", "drafting_with_approved_sending", "full_access"]),
          confirmFullAccess: z.boolean().optional(),
        }),
      ])
    )
    .mutation(async ({ ctx, input }) => {
      const { requestId, ...decision } = input
      const { redirectTo } = await decideConsent(requireContext(), ctx.actor, requestId, decision).catch(
        rethrowDomainError
      )
      return { redirectTo }
    }),
})
