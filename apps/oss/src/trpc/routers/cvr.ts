import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { cvrCompanySchema, onboardingSuggestionsSchema } from "@quits/contracts/cvr"
import { isCloudDistribution } from "../../lib/distribution"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { getCvrLookupProvider } from "../../lib/runtime/services"
import { researchCompany } from "../../lib/onboarding/company-research"
import { authorizedProcedure, protectedProcedure, router } from "../init"

export function lookupSignal(...signals: (AbortSignal | undefined)[]) {
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
  // The customer picker's name search; `search` belongs to onboarding and needs settings access.
  customerSearch: authorizedProcedure("contact:create")
    .input(z.object({ q: z.string().trim().min(3).max(120) }))
    .output(z.array(cvrCompanySchema).max(8))
    .query(({ ctx, input, signal }) => {
      const lookup = getCvrLookupProvider()
      if (!lookup) throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "CVR lookup is unavailable" })
      return lookup.search(input.q, { userId: ctx.user.id, organizationId: ctx.organizationId, signal: lookupSignal(signal, ctx.request?.signal) })
    }),
  // Whether the customer form can offer `customer`; self-hosted installs have no lookup provider.
  customerAvailable: authorizedProcedure("contact:create").query(() => ({ enabled: Boolean(getCvrLookupProvider()) })),
  available: authorizedProcedure("settings:read").query(() => ({
    enabled: cvrOnboardingEnabled(),
    suggestions: cvrOnboardingEnabled(),
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
    .query(async ({ ctx, input, signal }) => {
      const lookup = provider()
      const context = {
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
        signal: lookupSignal(signal, ctx.request?.signal),
      }
      const company = await lookup.get(input.cvr, context)
      if (!company || company.cvr !== input.cvr) return { customers: [], lines: [] }
      return researchCompany(company, lookup, context)
    }),
})
