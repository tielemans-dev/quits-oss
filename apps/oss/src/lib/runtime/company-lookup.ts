import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { getRuntimeCapabilities, getRuntimeExtensions } from "./extensions"
import type { SellerVatConfirmationActor } from "./seller-vat-confirmation"

/** Factual company data only. Registry VAT data is never an operator confirmation. */
export const companyLookupResultSchema = z.object({
  companies: z.array(z.object({
    cvr: z.string().regex(/^\d{8}$/), companyName: z.string().max(120),
    companyAddress: z.string().max(240), companyForm: z.string().max(80),
    statusText: z.string().max(120), presetsAllowed: z.boolean(),
  })).max(8),
  unavailable: z.boolean(),
})
export type CompanyLookupResult = z.infer<typeof companyLookupResultSchema>
export type CompanyLookupService = {
  lookup(input: SellerVatConfirmationActor & { query: string }): Promise<CompanyLookupResult>
}
export async function lookupOnboardingCompany(input: SellerVatConfirmationActor & { query: string }) {
  const capabilities = getRuntimeCapabilities()
  if (!capabilities.onboardingV2?.enabled || !capabilities.sellerVatConfirmation.enabled) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Company review is disabled" })
  }
  const providers = getRuntimeExtensions().flatMap(extension => extension.companyLookup ? [extension.companyLookup] : [])
  if (!providers.length) return { companies: [], unavailable: true }
  if (providers.length !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Company lookup is unavailable" })
  return companyLookupResultSchema.parse(await providers[0]!.lookup(input))
}
