import { TRPCError } from "@trpc/server"
import {
  countryCodeSchema,
  onboardingApplySourceSchema,
  onboardingAiSuggestionSchema,
  onboardingInvoicingIdentitySchema,
  onboardingMissingFieldSchema,
  onboardingPatchSchema,
  onboardingTaxRegimeSchema,
  onboardingValuesSchema,
  type OnboardingMissingField,
  type OnboardingPatch,
} from "@yaip/contracts/onboarding"
import { z } from "zod"
import { getCloudOnboardingState } from "../../lib/cloud-onboarding"
import { prisma } from "../../lib/db"
import { isCloudDistribution } from "../../lib/distribution"
import { appLogger } from "../../lib/observability"
import {
  evaluateOnboardingReadiness,
} from "../../lib/onboarding/readiness"
import {
  getRequirementRules,
  listFollowupQuestions as buildFollowupQuestions,
} from "../../lib/onboarding/ai-contract"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { getOnboardingAiService } from "../../lib/runtime/services"
import { authorizedProcedure, router } from "../init"

const onboardingLogger = appLogger.child("onboarding-ai")

const getRequirementRulesInputSchema = z.object({
  countryCode: countryCodeSchema.optional(),
  invoicingIdentity: onboardingInvoicingIdentitySchema.optional(),
  taxRegime: onboardingTaxRegimeSchema.optional(),
})

const suggestOnboardingPatchInputSchema = z.object({
  userMessage: z.string().trim().min(4).max(4000),
  currentValues: onboardingValuesSchema.optional(),
  missing: z.array(onboardingMissingFieldSchema).optional(),
})

const applyOnboardingPatchInputSchema = z.object({
  patch: onboardingPatchSchema,
  source: onboardingApplySourceSchema,
})

const validateReadinessInputSchema = z.object({
  values: onboardingValuesSchema,
})

const listFollowupQuestionsInputSchema = z.object({
  missing: z.array(onboardingMissingFieldSchema),
  values: onboardingValuesSchema.optional(),
})

function assertCloudOnboardingAiEnabled() {
  if (!isCloudDistribution) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Onboarding AI is cloud-only",
    })
  }

  const capabilities = getRuntimeCapabilities()
  if (!capabilities.onboardingAi.enabled) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Onboarding AI is disabled for this runtime",
    })
  }
}

async function loadSnapshot(organizationId: string) {
  const settings = await prisma.orgSettings.upsert({
    where: { organizationId },
    update: {},
    create: { organizationId },
    select: {
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

  const values = {
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
  }

  return {
    cloudState,
    readiness,
    values,
  }
}

function toMissingFieldList(fields: readonly string[]): OnboardingMissingField[] {
  const valid: OnboardingMissingField[] = [
    "companyName",
    "companyAddress",
    "companyEmail",
    "countryCode",
    "locale",
    "timezone",
    "defaultCurrency",
    "taxRegime",
    "invoicePrefix",
    "invoiceNextNum",
    "quotePrefix",
    "quoteNextNum",
    "primaryTaxId",
  ]
  const validSet = new Set(valid)
  return fields.filter((field): field is OnboardingMissingField =>
    validSet.has(field as OnboardingMissingField)
  )
}

function toPatchCurrentValues(
  values: Record<string, unknown> | undefined
): Partial<OnboardingPatch> {
  if (!values) return {}

  const candidate: Record<string, unknown> = {}

  if (typeof values.companyName === "string" && values.companyName.length > 0) {
    candidate.companyName = values.companyName
  }
  if (
    typeof values.companyAddress === "string" &&
    values.companyAddress.length > 0
  ) {
    candidate.companyAddress = values.companyAddress
  }
  if (
    typeof values.companyEmail === "string" &&
    values.companyEmail.length > 0
  ) {
    candidate.companyEmail = values.companyEmail
  }
  if (typeof values.countryCode === "string" && values.countryCode.length > 0) {
    candidate.countryCode = values.countryCode
  }
  if (
    values.invoicingIdentity === "individual" ||
    values.invoicingIdentity === "registered_business"
  ) {
    candidate.invoicingIdentity = values.invoicingIdentity
  }
  if (typeof values.locale === "string" && values.locale.length > 0) {
    candidate.locale = values.locale
  }
  if (typeof values.timezone === "string" && values.timezone.length > 0) {
    candidate.timezone = values.timezone
  }
  if (
    typeof values.defaultCurrency === "string" &&
    values.defaultCurrency.length > 0
  ) {
    candidate.defaultCurrency = values.defaultCurrency
  }
  if (
    values.taxRegime === "us_sales_tax" ||
    values.taxRegime === "eu_vat" ||
    values.taxRegime === "custom"
  ) {
    candidate.taxRegime = values.taxRegime
  }
  if (typeof values.pricesIncludeTax === "boolean") {
    candidate.pricesIncludeTax = values.pricesIncludeTax
  }
  if (
    typeof values.primaryTaxId === "string" &&
    values.primaryTaxId.length > 0
  ) {
    candidate.primaryTaxId = values.primaryTaxId
  }
  if (
    typeof values.primaryTaxIdScheme === "string" &&
    values.primaryTaxIdScheme.length > 0
  ) {
    candidate.primaryTaxIdScheme = values.primaryTaxIdScheme
  }
  if (
    typeof values.invoicePrefix === "string" &&
    /^[A-Z0-9-]{1,10}$/.test(values.invoicePrefix)
  ) {
    candidate.invoicePrefix = values.invoicePrefix
  }
  if (
    typeof values.quotePrefix === "string" &&
    /^[A-Z0-9-]{1,10}$/.test(values.quotePrefix)
  ) {
    candidate.quotePrefix = values.quotePrefix
  }

  return onboardingPatchSchema.parse(candidate)
}

async function applyPatchToOrgSettings(
  organizationId: string,
  patch: OnboardingPatch,
  source: "ai" | "manual"
) {
  const updateData: Record<string, unknown> = {
    onboardingStatus: "in_progress",
    onboardingMethod: source,
  }

  if ("companyName" in patch) updateData.companyName = patch.companyName
  if ("companyAddress" in patch) updateData.companyAddress = patch.companyAddress
  if ("companyEmail" in patch) updateData.companyEmail = patch.companyEmail
  if ("countryCode" in patch) updateData.countryCode = patch.countryCode
  if ("invoicingIdentity" in patch) {
    updateData.onboardingInvoicingIdentity = patch.invoicingIdentity
  }
  if ("locale" in patch) updateData.locale = patch.locale
  if ("timezone" in patch) updateData.timezone = patch.timezone
  if ("defaultCurrency" in patch) updateData.defaultCurrency = patch.defaultCurrency
  if ("taxRegime" in patch) updateData.taxRegime = patch.taxRegime
  if ("pricesIncludeTax" in patch) updateData.pricesIncludeTax = patch.pricesIncludeTax
  if ("invoicePrefix" in patch) updateData.invoicePrefix = patch.invoicePrefix
  if ("quotePrefix" in patch) updateData.quotePrefix = patch.quotePrefix

  await prisma.orgSettings.upsert({
    where: { organizationId },
    update: updateData,
    create: {
      organizationId,
      ...updateData,
    },
  })

  const primaryTaxId = patch.primaryTaxId
  if (typeof primaryTaxId === "string" && primaryTaxId.length > 0) {
    const existing = await prisma.organizationTaxId.findFirst({
      where: { organizationId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { id: true },
    })
    const scheme = patch.primaryTaxIdScheme ?? "vat"

    if (existing) {
      await prisma.organizationTaxId.update({
        where: { id: existing.id },
        data: {
          value: primaryTaxId,
          scheme,
          isPrimary: true,
        },
      })
    } else {
      await prisma.organizationTaxId.create({
        data: {
          organizationId,
          value: primaryTaxId,
          scheme,
          isPrimary: true,
        },
      })
    }
  }
}

export const onboardingAiRouter = router({
  getOnboardingState: authorizedProcedure("settings:read").query(async ({ ctx }) => {
    assertCloudOnboardingAiEnabled()
    const snapshot = await loadSnapshot(ctx.organizationId)
    const requiredNow = getRequirementRules({
      countryCode: snapshot.values.countryCode,
      invoicingIdentity: snapshot.values.invoicingIdentity,
      taxRegime: snapshot.values.taxRegime,
    }).requiredFields

    return {
      status: snapshot.cloudState.status,
      values: snapshot.values,
      missing: snapshot.readiness.missing,
      requiredNow,
    }
  }),

  getRequirementRules: authorizedProcedure("settings:read")
    .input(getRequirementRulesInputSchema)
    .query(({ input }) => {
      assertCloudOnboardingAiEnabled()
      return getRequirementRules(input)
    }),

  suggestOnboardingPatch: authorizedProcedure("settings:update")
    .input(suggestOnboardingPatchInputSchema)
    .mutation(async ({ ctx, input }) => {
      assertCloudOnboardingAiEnabled()
      const snapshot = await loadSnapshot(ctx.organizationId)
      const missing = toMissingFieldList(input.missing ?? snapshot.readiness.missing)
      const currentValues = toPatchCurrentValues({
        ...snapshot.values,
        ...input.currentValues,
      })
      try {
        const suggestion = await getOnboardingAiService().suggestPatch({
          userMessage: input.userMessage,
          currentValues,
          missing,
        })
        const parsedSuggestion = onboardingAiSuggestionSchema.parse(suggestion)

        onboardingLogger.info("onboarding_ai.suggestion.generated", {
          organizationId: ctx.organizationId,
          missingCount: missing.length,
          updatedFieldCount: Object.keys(parsedSuggestion.patch).length,
        })

        return parsedSuggestion
      } catch (error) {
        onboardingLogger.error("onboarding_ai.suggestion.failed", {
          organizationId: ctx.organizationId,
          missingCount: missing.length,
          error,
        })
        throw error
      }
    }),

  applyOnboardingPatch: authorizedProcedure("settings:update")
    .input(applyOnboardingPatchInputSchema)
    .mutation(async ({ ctx, input }) => {
      assertCloudOnboardingAiEnabled()
      try {
        await applyPatchToOrgSettings(ctx.organizationId, input.patch, input.source)
      } catch (error) {
        onboardingLogger.error("onboarding_ai.apply.failed", {
          organizationId: ctx.organizationId,
          source: input.source,
          patchFields: Object.keys(input.patch),
          error,
        })
        throw error
      }
      const snapshot = await loadSnapshot(ctx.organizationId)

      onboardingLogger.info("onboarding_ai.apply.succeeded", {
        organizationId: ctx.organizationId,
        source: input.source,
        patchFields: Object.keys(input.patch),
        missingCount: snapshot.readiness.missing.length,
        isComplete: snapshot.readiness.isComplete,
      })

      return {
        values: snapshot.values,
        missing: snapshot.readiness.missing,
        isComplete: snapshot.readiness.isComplete,
      }
    }),

  validateOnboardingReadiness: authorizedProcedure("settings:read")
    .input(validateReadinessInputSchema)
    .query(({ input }) => {
      assertCloudOnboardingAiEnabled()
      const readiness = evaluateOnboardingReadiness({
        companyName: input.values.companyName ?? null,
        companyAddress: input.values.companyAddress ?? null,
        companyEmail: input.values.companyEmail ?? null,
        countryCode: input.values.countryCode ?? null,
        invoicingIdentity: input.values.invoicingIdentity ?? null,
        locale: input.values.locale ?? null,
        timezone: input.values.timezone ?? null,
        defaultCurrency: input.values.defaultCurrency ?? null,
        taxRegime: input.values.taxRegime ?? null,
        pricesIncludeTax: input.values.pricesIncludeTax ?? null,
        invoicePrefix: input.values.invoicePrefix ?? null,
        invoiceNextNum: input.values.invoiceNextNum ?? null,
        quotePrefix: input.values.quotePrefix ?? null,
        quoteNextNum: input.values.quoteNextNum ?? null,
        primaryTaxId: input.values.primaryTaxId ?? null,
      })

      return {
        isComplete: readiness.isComplete,
        missing: readiness.missing,
        blockingReasons: readiness.missing.map(
          (field) => `Missing required field: ${field}`
        ),
      }
    }),

  listFollowupQuestions: authorizedProcedure("settings:read")
    .input(listFollowupQuestionsInputSchema)
    .query(({ input }) => {
      assertCloudOnboardingAiEnabled()
      const rules = getRequirementRules({
        countryCode: input.values?.countryCode,
        invoicingIdentity: input.values?.invoicingIdentity,
        taxRegime: input.values?.taxRegime,
      })
      const requiredMissing = toMissingFieldList(input.missing).filter((field) =>
        rules.requiredFields.includes(field)
      )

      return {
        questions: buildFollowupQuestions(requiredMissing),
      }
    }),
})
