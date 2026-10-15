import { TRPCError } from "@trpc/server"
import { isValidDanishCvr } from "@quits/contracts/onboarding"
import { getCvrLookupProvider } from "../runtime/services"

/** Registry checks belong to the hosted provider; self-host only checks the CVR format. */
export async function requireOnboardingCvr(input: {
  cvr: unknown; cloud: boolean; userId: string; organizationId?: string
}) {
  if (typeof input.cvr !== "string" || !isValidDanishCvr(input.cvr)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "cvr.invalid" })
  }
  if (!input.cloud) return null
  const provider = getCvrLookupProvider()
  if (!provider) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "cvr.unavailable" })
  const company = await provider.get(input.cvr, {
    userId: input.userId, organizationId: input.organizationId, signal: AbortSignal.timeout(10_000),
  })
  if (!company || company.cvr !== input.cvr || company.status !== "active" || company.statusClass !== "active") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "cvr.inactive" })
  }
  return company
}
