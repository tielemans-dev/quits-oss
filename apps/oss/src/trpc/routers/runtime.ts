import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { z } from "zod"
import { lookupOnboardingCompany } from "../../lib/runtime/company-lookup"
import { TRPCError } from "@trpc/server"
import { prisma } from "../../lib/db"
import { sellerConfirmationTaxIds, onboardingConfirmationTaxIds, settingsConfirmationTaxIds, getSellerVatConfirmationService } from "../../lib/runtime/seller-vat-confirmation"
import { authorizedProcedure, publicProcedure, router } from "../init"

export const runtimeRouter = router({
  lookupOnboardingCompany: authorizedProcedure("settings:update")
    .input(z.object({ query: z.string().trim().min(3).max(160) }).strict())
    .mutation(({ ctx, input }) => lookupOnboardingCompany({ ...input, organizationId: ctx.organizationId, userId: ctx.user.id, sessionId: ctx.session.session.id, request: ctx.request })),
  prepareSellerVatConfirmation: authorizedProcedure("settings:update")
    .input(z.object({ companyName: z.string().trim().min(1).max(120), companyAddress: z.string().trim().min(1).max(240), countryCode: z.literal("DK"), cvr: z.string().regex(/^(DK)?\d{8}$/), vatId: z.string().regex(/^DK\d{8}$/).optional(), primaryTaxIdScheme: z.string().trim().min(1).max(40).optional(), registered: z.boolean().nullable().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      const service = getSellerVatConfirmationService()
      if (!service) throw new TRPCError({ code: "FORBIDDEN", message: "Seller VAT confirmation is disabled" })
      if (input.vatId && (input.primaryTaxIdScheme !== undefined || input.vatId !== `DK${input.cvr}`)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid onboarding VAT identity" })
      }
      const orderedTaxIds = await prisma.organizationTaxId.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: input.primaryTaxIdScheme === undefined ? [{ createdAt: "asc" }] : [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: { scheme: true, value: true, countryCode: true },
      })
      const taxIds = input.primaryTaxIdScheme === undefined
        ? onboardingConfirmationTaxIds(orderedTaxIds, input.cvr, input.vatId)
        : settingsConfirmationTaxIds(orderedTaxIds, input.cvr, input.primaryTaxIdScheme, input.registered)
      return service.prepare({ organizationId: ctx.organizationId, userId: ctx.user.id, sessionId: ctx.session.session.id, request: ctx.request,
        seller: { companyName: input.companyName, companyAddress: input.companyAddress, countryCode: input.countryCode, taxIds: sellerConfirmationTaxIds(taxIds) } })
    }),
  capabilities: publicProcedure.query(() => getRuntimeCapabilities()),
})
