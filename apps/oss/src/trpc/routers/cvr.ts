import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { cvrCompanySchema, onboardingSuggestionsSchema } from "@quits/contracts/cvr"
import { isCloudDistribution } from "../../lib/distribution"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { getCvrLookupProvider } from "../../lib/runtime/services"
import { authorizedProcedure, protectedProcedure, router } from "../init"

function lookupSignal(...signals: (AbortSignal | undefined)[]) {
  const combined = AbortSignal.any([...signals.filter((signal): signal is AbortSignal => Boolean(signal)), AbortSignal.timeout(10_000)])
  combined.throwIfAborted()
  return combined
}

function provider() {
  const lookup = getCvrLookupProvider()
  if (!isCloudDistribution || !getRuntimeCapabilities().onboardingV2?.enabled || !lookup) {
    throw new TRPCError({ code: "FORBIDDEN", message: "CVR onboarding is unavailable" })
  }
  return lookup
}

function cvrOnboardingEnabled() {
  return isCloudDistribution && getRuntimeCapabilities().onboardingV2?.enabled === true && Boolean(getCvrLookupProvider())
}

export const cvrRouter = router({
  customer: authorizedProcedure("contact:create")
    .input(z.object({ cvr: z.string().regex(/^\d{8}$/) }))
    .output(cvrCompanySchema.nullable())
    .query(({ ctx, input, signal }) => {
      const lookup = getCvrLookupProvider()
      if (!lookup) throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "CVR lookup is unavailable" })
      return lookup.get(input.cvr, { userId: ctx.user.id, organizationId: ctx.organizationId, signal: lookupSignal(signal, ctx.request?.signal) })
    }),
  available: authorizedProcedure("settings:read").query(() => ({
    enabled: cvrOnboardingEnabled(),
    suggestions: Boolean(getCvrLookupProvider()?.suggestions),
  })),
  // Signed-in users without an organization use the same predicate as `available`, so the
  // name-only v2 start is only offered when the v2 wizard will actually render after creation.
  setupAvailable: protectedProcedure.query(() => ({ enabled: cvrOnboardingEnabled() })),
  search: authorizedProcedure("settings:update")
    .input(z.object({ q: z.string().trim().min(3).max(120) }))
    .output(z.array(cvrCompanySchema).max(8))
    .query(({ ctx, input, signal }) =>
      provider().search(input.q, {
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
        signal: lookupSignal(signal, ctx.request?.signal),
      }),
    ),
  get: authorizedProcedure("settings:update")
    .input(z.object({ cvr: z.string().regex(/^\d{8}$/) }))
    .output(cvrCompanySchema.nullable())
    .query(({ ctx, input, signal }) =>
      provider().get(input.cvr, {
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
        signal: lookupSignal(signal, ctx.request?.signal),
      }),
    ),
  suggestions: authorizedProcedure("settings:update")
    .input(z.object({ cvr: z.string().regex(/^\d{8}$/) }))
    .output(onboardingSuggestionsSchema)
    .query(({ ctx, input, signal }) => {
      const lookup = provider()
      if (!lookup.suggestions) throw new TRPCError({ code: "NOT_IMPLEMENTED" })
      return lookup.suggestions(input.cvr, {
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
        signal: lookupSignal(signal, ctx.request?.signal),
      })
    }),
})
