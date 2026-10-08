import { resolveBaseCurrency, hasIssuedDocuments } from "../../domain/documents/base-currency"
import { InvalidState } from "../../domain/errors"
import { assertSettingsCurrency } from "../currency"
import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, authorizedProcedure } from "../init"
import { Prisma } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import {
  createDocumentSendingSyncUpdate,
  readDocumentSendingDomainState,
  readDocumentSendingSyncState,
  resolveDocumentEmailEnvelope,
  validateDocumentSendingDomain,
} from "../../lib/document-email-sending"
import { getEmailDeliveryRuntimeStatus } from "../../lib/email-delivery"
import {
  AI_PROVIDER_KINDS,
  isAiEndpointHostAllowed,
  isAiProviderKind,
  type AiProviderKind,
} from "../../lib/ai/provider"
import { encryptSecret } from "../../lib/secrets"
import { getStripePaymentConfigurationState } from "../../lib/payments/stripe"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { getRuntimeEnv, getRuntimePlatform } from "../../lib/runtime/platform"
import { getManagedDocumentDomainProvider } from "../../lib/runtime/services"
import { localeSchema } from "../../lib/compliance/countries"
import { isCountryCode } from "../../lib/compliance/registry"
import { onboardingInvoicingIdentitySchema } from "@quits/contracts/onboarding"
import {
  normalizeCountryCode,
  validateLocalizedFields,
} from "../../lib/validation/localization"

const taxRegimeSchema = z.enum(["us_sales_tax", "eu_vat", "custom"])
const httpUrlRegex = /^https?:\/\/.+/i

/** An http(s) base URL for an AI endpoint. An empty string means "no endpoint" and clears it. */
const aiBaseUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    if (!value) return true
    try {
      const protocol = new URL(value).protocol
      return protocol === "http:" || protocol === "https:"
    } catch {
      return false
    }
  }, "AI endpoint must be an http or https URL")
  // The base URL is stored and shown in plain text; credentials belong in the encrypted API key.
  .refine((value) => {
    if (!value) return true
    try {
      const url = new URL(value)
      return !url.username && !url.password
    } catch {
      return true
    }
  }, "Put credentials in the API key field, not in the AI endpoint URL")

const aiProviderLabels: Record<AiProviderKind, string> = {
  openrouter: "OpenRouter",
  openai_compatible: "custom endpoint",
  cli_agent: "local agent",
}

/** Rejects saving a provider the distribution does not allow, so Settings cannot store a dead end. */
function assertAiProviderAllowed(kind: AiProviderKind) {
  const capabilities = getRuntimeCapabilities().aiInvoiceDraft
  const allowed =
    kind === "cli_agent"
      ? capabilities.localAgent
      : kind === "openai_compatible"
        ? capabilities.byok && capabilities.customEndpoint
        : capabilities.byok
  if (!allowed) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The ${aiProviderLabels[kind]} AI provider is not available on this server`,
    })
  }
}

const companyLogoSchema = z
  .string()
  .trim()
  .max(2_000_000)
  .refine(
    (value) => value.startsWith("data:image/") || httpUrlRegex.test(value),
    "Company logo must be an image URL or uploaded image data"
  )

const configureDocumentSendingDomainSchema = z.object({
  domain: z.string().trim().min(1).max(255),
})

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: value })
      return true
    } catch {
      return false
    }
  }, "Invalid time zone")

export const settingsUpdateSchema = z.object({
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  taxRate: z.number().min(0).max(100).nullable().optional(),
  companyName: z.string().trim().max(120).optional(),
  companyAddress: z.string().trim().max(240).optional(),
  companyEmail: z.string().trim().email().optional(),
  companyPhone: z.string().trim().max(40).optional(),
  companyLogo: companyLogoSchema.nullable().optional(),
  invoicePrefix: z.string().trim().regex(/^[A-Z0-9-]{1,10}$/).optional(),
  quotePrefix: z.string().trim().regex(/^[A-Z0-9-]{1,10}$/).optional(),
  creditNotePrefix: z.string().trim().regex(/^[A-Z0-9-]{1,10}$/).optional(),
  aiProvider: z.enum(AI_PROVIDER_KINDS).optional(),
  aiBaseUrl: aiBaseUrlSchema.nullable().optional(),
  aiModel: z.string().trim().min(1).max(120).optional(),
  // Local endpoints (Ollama, LM Studio, ...) may use short or placeholder keys, so no long minimum.
  aiApiKey: z.string().trim().min(1).max(500).optional(),
  clearAiApiKey: z.boolean().optional(),
  stripePublishableKey: z.string().trim().min(8).max(255).optional(),
  stripeSecretKey: z.string().trim().min(16).max(500).optional(),
  stripeWebhookSecret: z.string().trim().min(16).max(500).optional(),
  clearStripeSecretKey: z.boolean().optional(),
  clearStripeWebhookSecret: z.boolean().optional(),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase())
    .refine(isCountryCode, "Unknown country")
    .optional(),
  locale: localeSchema.optional(),
  timezone: timezoneSchema.optional(),
  baseCurrency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  defaultCurrency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  onboardingInvoicingIdentity: onboardingInvoicingIdentitySchema.optional(),
  taxRegime: taxRegimeSchema.optional(),
  pricesIncludeTax: z.boolean().optional(),
  primaryTaxId: z.string().trim().max(40).optional(),
  primaryTaxIdScheme: z.string().trim().max(40).optional(),
})

export const settingsRouter = router({
  get: authorizedProcedure("settings:read").query(async ({ ctx }) => {
    const primaryTaxId = await prisma.organizationTaxId.findFirst({
      where: { organizationId: ctx.organizationId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { value: true, scheme: true },
    })

    let settings = await prisma.orgSettings.findUnique({
      where: { organizationId: ctx.organizationId },
    })
    if (!settings) {
      settings = await prisma.orgSettings.create({
        data: { organizationId: ctx.organizationId },
      })
    }
    const stripeState = getStripePaymentConfigurationState({
      stripePublishableKey: settings.stripePublishableKey,
      stripeSecretKeyEnc: settings.stripeSecretKeyEnc,
      stripeWebhookSecretEnc: settings.stripeWebhookSecretEnc,
    })
    const runtimeCapabilities = getRuntimeCapabilities()
    const managedDocumentDomainProvider = getManagedDocumentDomainProvider()
    const environment = getRuntimeEnv()
    const emailDelivery = getEmailDeliveryRuntimeStatus({
      managed: runtimeCapabilities.emailDelivery.managed,
      resendApiKey: environment.RESEND_API_KEY,
      fromEmail: environment.FROM_EMAIL,
      emailProvider: environment.EMAIL_PROVIDER,
      smtp: environment,
      runtimeKind: getRuntimePlatform().getRuntimeKind(),
    })
    const documentSending = buildDocumentSendingState({
      settings,
      managed: runtimeCapabilities.emailDelivery.managed,
      supportsCustomDomain: managedDocumentDomainProvider.supported,
    })
    return {
      id: settings.id,
      countryCode: settings.countryCode,
      locale: settings.locale,
      timezone: settings.timezone,
      defaultCurrency: settings.defaultCurrency,
      baseCurrency: settings.baseCurrency,
      baseCurrencyLocked: await hasIssuedDocuments(prisma, ctx.organizationId),
      onboardingInvoicingIdentity: settings.onboardingInvoicingIdentity,
      taxRegime: settings.taxRegime,
      pricesIncludeTax: settings.pricesIncludeTax,
      currency: settings.currency,
      taxRate: settings.taxRate?.toNumber() ?? null,
      companyName: settings.companyName,
      companyAddress: settings.companyAddress,
      companyEmail: settings.companyEmail,
      companyPhone: settings.companyPhone,
      companyLogo: settings.companyLogo,
      invoicePrefix: settings.invoicePrefix,
      invoiceNextNum: settings.invoiceNextNum,
      quotePrefix: settings.quotePrefix,
      quoteNextNum: settings.quoteNextNum,
      creditNotePrefix: settings.creditNotePrefix,
      creditNoteNextNum: settings.creditNoteNextNum,
      aiByokConfigured: Boolean(settings.aiApiKeyEnc),
      aiProvider: isAiProviderKind(settings.aiProvider) ? settings.aiProvider : "openrouter",
      aiBaseUrl: settings.aiBaseUrl,
      aiModel: settings.aiModel,
      stripeByokConfigured: stripeState.configured,
      stripePublishableKey: settings.stripePublishableKey,
      primaryTaxId: primaryTaxId?.value ?? null,
      primaryTaxIdScheme: primaryTaxId?.scheme ?? null,
      emailDelivery,
      documentSending,
    }
  }),

  update: authorizedProcedure("settings:update")
    .input(settingsUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      const {
        primaryTaxId,
        primaryTaxIdScheme,
        aiApiKey,
        clearAiApiKey,
        aiBaseUrl,
        stripePublishableKey,
        stripeSecretKey,
        stripeWebhookSecret,
        clearStripeSecretKey,
        clearStripeWebhookSecret,
        ...settingsInput
      } = input


      assertSettingsCurrency(settingsInput.currency)
      assertSettingsCurrency(settingsInput.defaultCurrency)
      assertSettingsCurrency(settingsInput.baseCurrency)

      return prisma.$transaction(async (tx) => {
        let baseCurrency: string
        try { baseCurrency = await resolveBaseCurrency(tx, ctx.organizationId, settingsInput) }
        catch (error) { if (error instanceof InvalidState) throw new TRPCError({ code: "BAD_REQUEST", message: error.message }); throw error }
        const current = await tx.orgSettings.findUnique({
          where: { organizationId: ctx.organizationId },
          select: { countryCode: true, aiProvider: true, aiBaseUrl: true },
        })
        // Re-saving the stored provider is always fine; only switching to a new one is checked, so
        // capability changes on the server never block saving unrelated settings.
        if (settingsInput.aiProvider && settingsInput.aiProvider !== current?.aiProvider) {
          assertAiProviderAllowed(settingsInput.aiProvider)
        }
        const resolvedCountry = normalizeCountryCode(
          settingsInput.countryCode ?? current?.countryCode
        )
        const localizedIssues = validateLocalizedFields(resolvedCountry, {
          phone: settingsInput.companyPhone,
          taxId: primaryTaxId,
        })
        if (Object.values(localizedIssues).some(Boolean)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: Object.values(localizedIssues).filter(Boolean).join(" "),
          })
        }

        // A saved key belongs to the provider and endpoint it was entered for. Never send it to a
        // different one: changing either without entering a new key clears the old key.
        const aiDestinationChanged =
          (settingsInput.aiProvider !== undefined &&
            settingsInput.aiProvider !== current?.aiProvider) ||
          (aiBaseUrl !== undefined && (aiBaseUrl || null) !== (current?.aiBaseUrl ?? null))
        const dropSavedAiKey = clearAiApiKey || (aiDestinationChanged && !aiApiKey)

        if (aiBaseUrl && !isAiEndpointHostAllowed(aiBaseUrl)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This AI endpoint's host is not allowed on this server",
          })
        }
        // A model saved for one provider rarely exists on another, so a switch needs a model too.
        // The local agent picks its own model.
        if (
          settingsInput.aiProvider !== undefined &&
          settingsInput.aiProvider !== current?.aiProvider &&
          settingsInput.aiProvider !== "cli_agent" &&
          !settingsInput.aiModel
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Choose a model for the new AI provider",
          })
        }

        const settingsUpdateData = {
          ...settingsInput,
          baseCurrency,
          ...(aiBaseUrl !== undefined ? { aiBaseUrl: aiBaseUrl || null } : {}),
          ...(aiApiKey ? { aiApiKeyEnc: encryptSecret(aiApiKey) } : {}),
          ...(dropSavedAiKey ? { aiApiKeyEnc: null } : {}),
          ...(stripePublishableKey !== undefined
            ? { stripePublishableKey: stripePublishableKey || null }
            : {}),
          ...(stripeSecretKey
            ? { stripeSecretKeyEnc: encryptSecret(stripeSecretKey) }
            : {}),
          ...(stripeWebhookSecret
            ? { stripeWebhookSecretEnc: encryptSecret(stripeWebhookSecret) }
            : {}),
          ...(clearStripeSecretKey ? { stripeSecretKeyEnc: null } : {}),
          ...(clearStripeWebhookSecret ? { stripeWebhookSecretEnc: null } : {}),
        }

        const settings = await tx.orgSettings.upsert({
          where: { organizationId: ctx.organizationId },
          update: settingsUpdateData,
          create: { organizationId: ctx.organizationId, ...settingsUpdateData },
        })

        if (primaryTaxId && primaryTaxId.trim()) {
          const existing = await tx.organizationTaxId.findFirst({
            where: { organizationId: ctx.organizationId },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            select: { id: true },
          })

          if (existing) {
            await tx.organizationTaxId.update({
              where: { id: existing.id },
              data: {
                value: primaryTaxId.trim(),
                scheme: primaryTaxIdScheme?.trim() || "vat",
                isPrimary: true,
              },
            })
          } else {
            await tx.organizationTaxId.create({
              data: {
                organizationId: ctx.organizationId,
                value: primaryTaxId.trim(),
                scheme: primaryTaxIdScheme?.trim() || "vat",
                isPrimary: true,
              },
            })
          }
        }

        return settings
      })
    }),

  configureDocumentSendingDomain: authorizedProcedure("settings:update")
    .input(configureDocumentSendingDomainSchema)
    .mutation(async ({ ctx, input }) => {
      const provider = getManagedDocumentDomainProvider()
      if (!provider.supported) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Custom sending domains are not available",
        })
      }

      const validation = validateDocumentSendingDomain(input.domain)
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: validation.reason,
        })
      }

      const current = await prisma.orgSettings.upsert({
        where: { organizationId: ctx.organizationId },
        update: {},
        create: { organizationId: ctx.organizationId },
      })

      const currentState = readDocumentSendingDomainState(current)
      if (
        currentState.providerId &&
        currentState.domain &&
        currentState.domain !== validation.normalizedDomain
      ) {
        await provider.deleteDomain({
          providerId: currentState.providerId,
          domain: currentState.domain,
        })
      }

      const created = await provider.createDomain({
        domain: validation.normalizedDomain,
      })

      const settings = await prisma.orgSettings.update({
        where: { organizationId: ctx.organizationId },
        data: {
          documentSendingDomain: created.domain,
          documentSendingDomainProviderId: created.providerId,
          documentSendingDomainStatus: created.status,
          documentSendingDomainRecords: created.records,
          documentSendingDomainFailureReason: created.failureReason,
          documentSendingDomainVerifiedAt: created.verifiedAt,
        },
      })

      return buildDocumentSendingState({
        settings,
        managed: getRuntimeCapabilities().emailDelivery.managed,
        supportsCustomDomain: provider.supported,
      })
    }),

  refreshDocumentSendingDomain: authorizedProcedure("settings:update")
    .input(z.void())
    .mutation(async ({ ctx }) => {
      const provider = getManagedDocumentDomainProvider()
      if (!provider.supported) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Custom sending domains are not available",
        })
      }

      const current = await prisma.orgSettings.upsert({
        where: { organizationId: ctx.organizationId },
        update: {},
        create: { organizationId: ctx.organizationId },
      })
      const currentState = readDocumentSendingDomainState(current)

      if (!currentState.providerId || !currentState.domain) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No branded sending domain is configured",
        })
      }

      const refreshed = await provider.refreshDomain({
        providerId: currentState.providerId,
        domain: currentState.domain,
      })

      const settings = await prisma.orgSettings.update({
        where: { organizationId: ctx.organizationId },
        data: {
          documentSendingDomain: refreshed.domain,
          documentSendingDomainProviderId: refreshed.providerId,
          documentSendingDomainStatus: refreshed.status,
          documentSendingDomainRecords: refreshed.records,
          documentSendingDomainFailureReason: refreshed.failureReason,
          documentSendingDomainVerifiedAt: refreshed.verifiedAt,
          ...createDocumentSendingSyncUpdate({ source: "manual" }),
        },
      })

      return buildDocumentSendingState({
        settings,
        managed: getRuntimeCapabilities().emailDelivery.managed,
        supportsCustomDomain: provider.supported,
      })
    }),

  disableDocumentSendingDomain: authorizedProcedure("settings:update")
    .input(z.void())
    .mutation(async ({ ctx }) => {
      const provider = getManagedDocumentDomainProvider()
      const current = await prisma.orgSettings.upsert({
        where: { organizationId: ctx.organizationId },
        update: {},
        create: { organizationId: ctx.organizationId },
      })
      const currentState = readDocumentSendingDomainState(current)

      if (provider.supported && currentState.providerId && currentState.domain) {
        await provider.deleteDomain({
          providerId: currentState.providerId,
          domain: currentState.domain,
        })
      }

      const settings = await prisma.orgSettings.update({
        where: { organizationId: ctx.organizationId },
        data: {
          documentSendingDomain: null,
          documentSendingDomainProviderId: null,
          documentSendingDomainStatus: null,
          documentSendingDomainRecords: Prisma.DbNull,
          documentSendingDomainFailureReason: null,
          documentSendingDomainVerifiedAt: null,
        },
      })

      return buildDocumentSendingState({
        settings,
        managed: getRuntimeCapabilities().emailDelivery.managed,
        supportsCustomDomain: provider.supported,
      })
    }),
})

function buildDocumentSendingState(input: {
  settings: {
    companyName?: string | null
    companyEmail?: string | null
    documentSendingDomain?: string | null
    documentSendingDomainProviderId?: string | null
    documentSendingDomainStatus?: string | null
    documentSendingDomainRecords?: unknown
    documentSendingDomainFailureReason?: string | null
    documentSendingDomainVerifiedAt?: Date | null
    documentSendingLastSyncedAt?: Date | null
    documentSendingLastSyncSource?: string | null
  }
  managed: boolean
  supportsCustomDomain: boolean
}) {
  const environment = getRuntimeEnv()
  const sharedSender = resolveDocumentEmailEnvelope({
    orgName: input.settings.companyName,
    orgBillingEmail: input.settings.companyEmail,
    sharedFromEmail: environment.FROM_EMAIL ?? "noreply@yaip.app",
  })
  const brandedState = input.supportsCustomDomain
    ? readDocumentSendingDomainState(input.settings)
    : readDocumentSendingDomainState({})
  const effectiveSender = resolveDocumentEmailEnvelope({
    orgName: input.settings.companyName,
    orgBillingEmail: input.settings.companyEmail,
    sharedFromEmail: environment.FROM_EMAIL ?? "noreply@yaip.app",
    branded: brandedState,
  })
  const syncState = readDocumentSendingSyncState(input.settings)

  return {
    managed: input.managed,
    supportsCustomDomain: input.supportsCustomDomain,
    status: brandedState.status,
    requestedDomain: brandedState.domain,
    records: brandedState.records,
    failureReason: brandedState.failureReason,
    verifiedAt: brandedState.verifiedAt,
    lastSyncedAt: syncState.lastSyncedAt,
    lastSyncSource: syncState.lastSyncSource,
    sharedSender,
    effectiveSender,
  }
}
