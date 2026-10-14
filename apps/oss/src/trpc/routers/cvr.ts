import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { cvrCompanySchema, onboardingSuggestionsSchema } from "@quits/contracts/cvr"
import { isCloudDistribution } from "../../lib/distribution"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { getCvrLookupProvider } from "../../lib/runtime/services"
import { authorizedProcedure, router } from "../init"

function provider() {
  const lookup = getCvrLookupProvider()
  if (!isCloudDistribution || !getRuntimeCapabilities().onboardingV2?.enabled || !lookup) {
    throw new TRPCError({ code: "FORBIDDEN", message: "CVR onboarding is unavailable" })
  }
  return lookup
}

export const cvrRouter = router({
  available: authorizedProcedure("settings:read").query(() => ({
    enabled:
      isCloudDistribution &&
      getRuntimeCapabilities().onboardingV2?.enabled === true &&
      Boolean(getCvrLookupProvider()),
    suggestions: Boolean(getCvrLookupProvider()?.suggestions),
  })),
  search: authorizedProcedure("settings:update")
    .input(z.object({ q: z.string().trim().min(3).max(120) }))
    .output(z.array(cvrCompanySchema).max(8))
    .query(({ ctx, input }) =>
      provider().search(input.q, {
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
        signal: AbortSignal.timeout(10_000),
      }),
    ),
  get: authorizedProcedure("settings:update")
    .input(z.object({ cvr: z.string().regex(/^\d{8}$/) }))
    .output(cvrCompanySchema.nullable())
    .query(({ ctx, input }) =>
      provider().get(input.cvr, {
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
        signal: AbortSignal.timeout(10_000),
      }),
    ),
  suggestions: authorizedProcedure("settings:update")
    .input(z.object({ cvr: z.string().regex(/^\d{8}$/) }))
    .output(onboardingSuggestionsSchema)
    .query(({ ctx, input }) => {
      const lookup = provider()
      if (!lookup.suggestions) throw new TRPCError({ code: "NOT_IMPLEMENTED" })
      return lookup.suggestions(input.cvr, {
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
        signal: AbortSignal.timeout(10_000),
      })
    }),
})
