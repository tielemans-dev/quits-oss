import { resolveBaseCurrency } from "../../domain/documents/base-currency"
import { assertSettingsCurrency } from "../currency"
import { z } from "zod"
import { TRPCError } from "@trpc/server"
import {
  CLOUD_ONBOARDING_VERSION,
  cloudOnboardingProfileSchema,
  getCloudOnboardingState,
  getProfileDefaults,
} from "../../lib/cloud-onboarding"
import { isCloudDistribution } from "../../lib/distribution"
import { prisma } from "../../lib/db"
import { evaluateOnboardingReadiness } from "../../lib/onboarding/readiness"
import { onboardingInvoicingIdentitySchema } from "@quits/contracts/onboarding"
import { localeSchema } from "../../lib/compliance/countries"
import { isCountryCode } from "../../lib/compliance/registry"
import { authorizedProcedure, router } from "../init"

const onboardingInputSchema = z.object({
  profile: cloudOnboardingProfileSchema,
})

const onboardingDraftSchema = z.object({
  companyName: z.string().trim().max(120).optional(),
  companyAddress: z.string().trim().max(240).optional(),
  companyEmail: z.string().trim().email().optional(),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase())
    .refine(isCountryCode, "Unknown country")
    .optional(),
  invoicingIdentity: onboardingInvoicingIdentitySchema.optional(),
  locale: localeSchema.optional(),
  timezone: z.string().trim().min(1).max(120).optional(),
  defaultCurrency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  taxRegime: z.enum(["us_sales_tax", "eu_vat", "custom"]).optional(),
  pricesIncludeTax: z.boolean().optional(),
  invoicePrefix: z
    .string()
    .trim()
    .regex(/^[A-Z0-9-]{1,10}$/)
    .optional(),
  invoiceNextNum: z.number().int().min(1).optional(),
  quotePrefix: z
    .string()
    .trim()
    .regex(/^[A-Z0-9-]{1,10}$/)
    .optional(),
  quoteNextNum: z.number().int().min(1).optional(),
  primaryTaxId: z
    .preprocess(
      (value) =>
        typeof value === "string" && value.trim().length === 0 ? null : value,
      z.string().trim().max(40).nullable().optional()
    ),
  primaryTaxIdScheme: z.string().trim().max(40).optional(),
})

const completeManualInputSchema = z.object({
  method: z.enum(["manual", "ai"]).default("manual"),
})

type OnboardingSnapshot = Awaited<ReturnType<typeof loadOnboardingSnapshot>>

async function loadOnboardingSnapshot(organizationId: string) {
  const settings = await prisma.orgSettings.upsert({
    where: { organizationId },
    update: {},
    create: { organizationId },
    select: {
      organizationId: true,
      onboardingStatus: true,
      onboardingMethod: true,
      onboardingProfile: true,
      onboardingInvoicingIdentity: true,
      onboardingVersion: true,
      onboardingCompletedAt: true,
      countryCode: true,
      locale: true,
      timezone: true,
      defaultCurrency: true,
      taxRegime: true,
      pricesIncludeTax: true,
      companyName: true,
      companyAddress: true,
      companyEmail: true,
      invoicePrefix: true,
      invoiceNextNum: true,
      quotePrefix: true,
      quoteNextNum: true,
    },
  })

  const primaryTaxId = await prisma.organizationTaxId.findFirst({
    where: { organizationId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { value: true, scheme: true },
  })

  const readiness = evaluateOnboardingReadiness({
    countryCode: settings.countryCode,
    invoicingIdentity: settings.onboardingInvoicingIdentity,
    locale: settings.locale,
    timezone: settings.timezone,
    defaultCurrency: settings.defaultCurrency,
    taxRegime: settings.taxRegime,
    pricesIncludeTax: settings.pricesIncludeTax,
    companyName: settings.companyName,
    companyAddress: settings.companyAddress,
    companyEmail: settings.companyEmail,
    invoicePrefix: settings.invoicePrefix,
    invoiceNextNum: settings.invoiceNextNum,
    quotePrefix: settings.quotePrefix,
    quoteNextNum: settings.quoteNextNum,
    primaryTaxId: primaryTaxId?.value ?? null,
  })

  const cloudState = getCloudOnboardingState({
    onboardingStatus: settings.onboardingStatus,
    onboardingMethod: settings.onboardingMethod,
    onboardingProfile: settings.onboardingProfile,
    onboardingInvoicingIdentity: settings.onboardingInvoicingIdentity,
    onboardingVersion: settings.onboardingVersion,
    onboardingCompletedAt: settings.onboardingCompletedAt,
    countryCode: settings.countryCode,
    locale: settings.locale,
    timezone: settings.timezone,
    defaultCurrency: settings.defaultCurrency,
    taxRegime: settings.taxRegime,
    pricesIncludeTax: settings.pricesIncludeTax,
    companyName: settings.companyName,
    companyAddress: settings.companyAddress,
    companyEmail: settings.companyEmail,
    invoicePrefix: settings.invoicePrefix,
    invoiceNextNum: settings.invoiceNextNum,
    quotePrefix: settings.quotePrefix,
    quoteNextNum: settings.quoteNextNum,
    primaryTaxId: primaryTaxId?.value ?? null,
  })

  return {
    cloudState,
    readiness,
    values: {
      companyName: settings.companyName,
      companyAddress: settings.companyAddress,
      companyEmail: settings.companyEmail,
      countryCode: settings.countryCode,
      invoicingIdentity: settings.onboardingInvoicingIdentity,
      locale: settings.locale,
      timezone: settings.timezone,
      defaultCurrency: settings.defaultCurrency,
      taxRegime: settings.taxRegime,
      pricesIncludeTax: settings.pricesIncludeTax,
      invoicePrefix: settings.invoicePrefix,
      invoiceNextNum: settings.invoiceNextNum,
      quotePrefix: settings.quotePrefix,
      quoteNextNum: settings.quoteNextNum,
      primaryTaxId: primaryTaxId?.value ?? null,
      primaryTaxIdScheme: primaryTaxId?.scheme ?? null,
      onboardingMethod: settings.onboardingMethod,
    },
  }
}

function toOnboardingResponse(snapshot: OnboardingSnapshot) {
  return {
    status: snapshot.cloudState.status,
    isComplete: snapshot.cloudState.isComplete,
    missing: snapshot.readiness.missing,
    values: snapshot.values,
    profile: snapshot.cloudState.profile,
    version: snapshot.cloudState.version,
    completedAt: snapshot.cloudState.completedAt,
  }
}

export const onboardingRouter = router({
  getStatus: authorizedProcedure("settings:read").query(async ({ ctx }) => {
    if (!isCloudDistribution) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Cloud onboarding is disabled in self-host distribution",
      })
    }

    const snapshot = await loadOnboardingSnapshot(ctx.organizationId)
    return toOnboardingResponse(snapshot)
  }),

  saveDraft: authorizedProcedure("settings:update")
    .input(onboardingDraftSchema)
    .mutation(async ({ ctx, input }) => {
      if (!isCloudDistribution) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cloud onboarding is disabled in self-host distribution",
        })
      }

      const settingsUpdateData: Record<string, unknown> = {
        onboardingStatus: "in_progress",
      }

      if ("companyName" in input) settingsUpdateData.companyName = input.companyName ?? null
      if ("companyAddress" in input)
        settingsUpdateData.companyAddress = input.companyAddress ?? null
      if ("companyEmail" in input) settingsUpdateData.companyEmail = input.companyEmail ?? null
      if ("countryCode" in input) settingsUpdateData.countryCode = input.countryCode
      if ("invoicingIdentity" in input) {
        settingsUpdateData.onboardingInvoicingIdentity = input.invoicingIdentity
      }
      if ("locale" in input) settingsUpdateData.locale = input.locale
      if ("timezone" in input) settingsUpdateData.timezone = input.timezone
      if ("defaultCurrency" in input) {
        assertSettingsCurrency(input.defaultCurrency)
        settingsUpdateData.defaultCurrency = input.defaultCurrency
      }
      if ("taxRegime" in input) settingsUpdateData.taxRegime = input.taxRegime
      if ("pricesIncludeTax" in input)
        settingsUpdateData.pricesIncludeTax = input.pricesIncludeTax
      if ("invoicePrefix" in input)
        settingsUpdateData.invoicePrefix = input.invoicePrefix
      if ("invoiceNextNum" in input)
        settingsUpdateData.invoiceNextNum = input.invoiceNextNum
      if ("quotePrefix" in input) settingsUpdateData.quotePrefix = input.quotePrefix
      if ("quoteNextNum" in input) settingsUpdateData.quoteNextNum = input.quoteNextNum

      await prisma.$transaction(async tx => {
        settingsUpdateData.baseCurrency = await resolveBaseCurrency(tx, ctx.organizationId, { countryCode: settingsUpdateData.countryCode as string | undefined })
        await tx.orgSettings.upsert({
        where: { organizationId: ctx.organizationId },
        update: settingsUpdateData,
        create: {
          organizationId: ctx.organizationId,
          ...settingsUpdateData,
        },
      })
      })

      if ("primaryTaxId" in input) {
        const trimmedTaxId = input.primaryTaxId?.trim() ?? ""
        if (!trimmedTaxId) {
          await prisma.organizationTaxId.deleteMany({
            where: { organizationId: ctx.organizationId },
          })
        } else {
          const existing = await prisma.organizationTaxId.findFirst({
            where: { organizationId: ctx.organizationId },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            select: { id: true },
          })
          const scheme = input.primaryTaxIdScheme?.trim() || "vat"
          if (existing) {
            await prisma.organizationTaxId.update({
              where: { id: existing.id },
              data: {
                value: trimmedTaxId,
                scheme,
                isPrimary: true,
              },
            })
          } else {
            await prisma.organizationTaxId.create({
              data: {
                organizationId: ctx.organizationId,
                value: trimmedTaxId,
                scheme,
                isPrimary: true,
              },
            })
          }
        }
      }

      const snapshot = await loadOnboardingSnapshot(ctx.organizationId)
      return toOnboardingResponse(snapshot)
    }),

  completeManual: authorizedProcedure("settings:update")
    .input(completeManualInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!isCloudDistribution) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cloud onboarding is disabled in self-host distribution",
        })
      }

      const snapshot = await loadOnboardingSnapshot(ctx.organizationId)

      if (!snapshot.readiness.isComplete) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Onboarding is incomplete. Missing: ${snapshot.readiness.missing.join(", ")}`,
        })
      }

      await prisma.orgSettings.update({
        where: { organizationId: ctx.organizationId },
        data: {
          onboardingStatus: "complete",
          onboardingMethod: input.method,
          onboardingVersion: CLOUD_ONBOARDING_VERSION,
          onboardingCompletedAt: new Date(),
        },
      })

      return toOnboardingResponse(await loadOnboardingSnapshot(ctx.organizationId))
    }),

  complete: authorizedProcedure("settings:update").input(onboardingInputSchema).mutation(async ({ ctx, input }) => {
    if (!isCloudDistribution) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Cloud onboarding is disabled in self-host distribution",
      })
    }

    const snapshot = await loadOnboardingSnapshot(ctx.organizationId)
    if (snapshot.cloudState.status === "complete") {
      return toOnboardingResponse(snapshot)
    }

    const defaults = getProfileDefaults(input.profile)

    await prisma.orgSettings.upsert({
      where: { organizationId: ctx.organizationId },
      update: {
        onboardingStatus: "in_progress",
        onboardingMethod: "manual",
        onboardingProfile: defaults.onboardingProfile,
        onboardingVersion: CLOUD_ONBOARDING_VERSION,
        onboardingCompletedAt: null,
        taxRegime: defaults.taxRegime,
        pricesIncludeTax: defaults.pricesIncludeTax,
        invoicePrefix: defaults.invoicePrefix,
        quotePrefix: defaults.quotePrefix,
      },
      create: {
        organizationId: ctx.organizationId,
        taxRegime: defaults.taxRegime,
        pricesIncludeTax: defaults.pricesIncludeTax,
        invoicePrefix: defaults.invoicePrefix,
        quotePrefix: defaults.quotePrefix,
        onboardingStatus: "in_progress",
        onboardingMethod: "manual",
        onboardingProfile: defaults.onboardingProfile,
        onboardingVersion: CLOUD_ONBOARDING_VERSION,
        onboardingCompletedAt: null,
      },
    })

    return toOnboardingResponse(await loadOnboardingSnapshot(ctx.organizationId))
  }),
})
