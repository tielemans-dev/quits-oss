import { requireOnboardingCvr } from "../../lib/onboarding/require-cvr"
import { isCloudDistribution } from "../../lib/distribution"
import { translate } from "../../lib/i18n/translate"
import { isValidDanishCvr } from "@quits/contracts/onboarding"
import { localizedNonVatPaymentNote } from "../../lib/documents/non-vat-note"
import { toTrpcError } from "../outcome"
import { confirmSellerVatStatus } from "../../lib/runtime/seller-vat-confirmation"
import { resolveBaseCurrency, hasIssuedDocuments } from "../../domain/documents/base-currency"
import { InvalidState } from "../../domain/errors"
import { isUniqueViolation } from "../../domain/execute"
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
import { tryParseSenderAddress } from "../../lib/email-sender"
import {
  AI_PROVIDER_KINDS,
  isAiEndpointHostAllowed,
  isAiProviderKind,
  type AiProviderKind,
} from "../../lib/ai/provider"
import { encryptSecret } from "../../lib/secrets"
import { getStripePaymentConfigurationState, resolveStripeCheckoutTarget, stripeByokConfigured, usesStripeConnectCheckout } from "../../lib/payments/stripe"
import { appLogger } from "../../lib/observability"
import { actorCan } from "../../domain/actor"
import { getRuntimeCapabilities, isNonVatRegistrationAllowed } from "../../lib/runtime/extensions"
import { getRuntimeEnv, getRuntimePlatform } from "../../lib/runtime/platform"
import { getManagedDocumentDomainProvider, getStripeConnectSettingsHandler } from "../../lib/runtime/services"
import {
  stripeConnectRedirectUrl,
  stripeConnectSettingsActions,
} from "../../lib/runtime/stripe-connect-settings"
import { localeSchema } from "../../lib/compliance/countries"
import { isCountryCode, isNationalRegistrationScheme, nationalRegistrationForScheme } from "../../lib/compliance/registry"
import { onboardingInvoicingIdentitySchema } from "@quits/contracts/onboarding"
import { orgStripeAccountSchema, type OrgStripeAccount } from "@quits/contracts/payments"
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
  momsRegistered: z.boolean().nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(3650).optional(),
  sellerVatConfirmationToken: z.string().max(2048).optional(),
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
  aiDraftsEnabled: z.boolean().optional(),
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

/** Columns `settings.get` maps into its response. Keep in sync with that mapping. */
const orgSettingsReadSelect = {
  id: true,
  countryCode: true,
  locale: true,
  timezone: true,
  defaultCurrency: true,
  baseCurrency: true,
  onboardingInvoicingIdentity: true,
  taxRegime: true,
  pricesIncludeTax: true,
  currency: true,
  paymentTermsDays: true,
  taxRate: true,
  momsRegistered: true,
  companyName: true,
  companyAddress: true,
  companyEmail: true,
  companyPhone: true,
  companyLogo: true,
  invoicePrefix: true,
  invoiceNextNum: true,
  quotePrefix: true,
  quoteNextNum: true,
  creditNotePrefix: true,
  creditNoteNextNum: true,
  aiProvider: true,
  aiBaseUrl: true,
  aiApiKeyEnc: true,
  aiModel: true,
  aiDraftsEnabled: true,
  stripePublishableKey: true,
  stripeSecretKeyEnc: true,
  stripeWebhookSecretEnc: true,
  stripeAccountId: true,
  stripeAccountStatus: true,
  stripeAccountStatusAt: true,
  stripeAccountBusinessName: true,
  documentSendingDomain: true,
  documentSendingDomainProviderId: true,
  documentSendingDomainStatus: true,
  documentSendingDomainRecords: true,
  documentSendingDomainFailureReason: true,
  documentSendingDomainVerifiedAt: true,
  documentSendingLastSyncedAt: true,
  documentSendingLastSyncSource: true,
} satisfies Prisma.OrgSettingsSelect

/**
 * Creates the default settings row on first read. A concurrent first read may create it
 * first; the unique organizationId then rejects this insert and the existing row is read.
 */
async function createDefaultOrgSettings(organizationId: string) {
  try {
    return await prisma.orgSettings.create({
      data: { organizationId },
      select: orgSettingsReadSelect,
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return prisma.orgSettings.findUniqueOrThrow({
      where: { organizationId },
      select: orgSettingsReadSelect,
    })
  }
}

/** Every malformed Danish CVR refusal is the same structured field issue, wherever it is detected. */
const invalidCvr = (locale: string | null | undefined) => toTrpcError({ tag: "InvalidState", code: "invalid_cvr", message: translate("cvr.invalid", locale), fieldIssues: [{ code: "cvr.invalid", field: "primaryTaxId", params: {} }] })

export const settingsRouter = router({
  get: authorizedProcedure("settings:read").query(async ({ ctx }) => {
    // Three independent reads run concurrently: each is a database round trip on hosted
    // runtimes. Keep this fan-out small; hosted runtimes cap simultaneous connections.
    const [primaryTaxId, existingSettings, baseCurrencyLocked] = await Promise.all([
      prisma.organizationTaxId.findFirst({
        where: { organizationId: ctx.organizationId },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: { value: true, scheme: true },
      }),
      prisma.orgSettings.findUnique({
        where: { organizationId: ctx.organizationId },
        select: orgSettingsReadSelect,
      }),
      hasIssuedDocuments(prisma, ctx.organizationId),
    ])
    const settings = existingSettings ?? (await createDefaultOrgSettings(ctx.organizationId))
    const runtimeCapabilities = getRuntimeCapabilities()
    const connectMode = usesStripeConnectCheckout()
    const stripeState = getStripePaymentConfigurationState({
      stripePublishableKey: settings.stripePublishableKey,
      stripeSecretKeyEnc: settings.stripeSecretKeyEnc,
      stripeWebhookSecretEnc: settings.stripeWebhookSecretEnc,
      stripeAccountStatus: settings.stripeAccountStatus,
    })
    // Cached readiness alone does not supply the runtime's Connect checkout client.
    const stripeTarget = stripeState.configured
      ? await resolveStripeCheckoutTarget(
          { organizationId: ctx.organizationId },
          { connectReady: settings.stripeAccountStatus === "active" },
        ).catch(() => {
          appLogger.warn("settings.stripe_checkout_target_unavailable", { organizationId: ctx.organizationId })
          return null
        })
      : null
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
      baseCurrencyLocked,
      onboardingInvoicingIdentity: settings.onboardingInvoicingIdentity,
      taxRegime: settings.taxRegime,
      pricesIncludeTax: settings.pricesIncludeTax,
      currency: settings.currency,
      paymentTermsDays: settings.paymentTermsDays,
      taxRate: settings.taxRate?.toNumber() ?? null,
      momsRegistered: settings.momsRegistered,
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
      // Hosted runs the model itself, so Settings shows one switch (or nothing) instead of provider fields.
      aiDrafts: connectMode
        ? { managed: true as const, available: runtimeCapabilities.aiInvoiceDraft.managed, enabled: settings.aiDraftsEnabled }
        : { managed: false as const, available: true, enabled: true },
      stripeByokConfigured: stripeByokConfigured(settings),
      stripePaymentsEnabled: Boolean(stripeTarget),
      stripeCheckoutKind: stripeTarget?.kind ?? null,
      stripePublishableKey: settings.stripePublishableKey,
      stripeAccount: readStripeAccount({
        managed: connectMode,
        accountId: settings.stripeAccountId,
        businessName: settings.stripeAccountBusinessName,
        status: settings.stripeAccountStatus,
        statusAt: settings.stripeAccountStatusAt,
      }),
      stripeConnectActions:
        runtimeCapabilities.payments.managed &&
        getStripeConnectSettingsHandler() != null &&
        actorCan(ctx.actor, "settings:update"),
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
        sellerVatConfirmationToken,
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

      // The registry's 10-second deadline must fit inside the atomic save.
      return prisma.$transaction(async (tx) => {
        let baseCurrency: string
        try { baseCurrency = await resolveBaseCurrency(tx, ctx.organizationId, settingsInput) }
        catch (error) { if (error instanceof InvalidState) throw new TRPCError({ code: "BAD_REQUEST", message: error.message }); throw error }
        const current = await tx.orgSettings.findUnique({
          where: { organizationId: ctx.organizationId },
          select: {
            countryCode: true,
            locale: true,
            paymentNote: true,
            taxRegime: true,
            momsRegistered: true,
            aiProvider: true,
            aiBaseUrl: true,
            companyName: true,
            companyAddress: true,
            stripePublishableKey: true,
          },
        })
        assertStripeByokWritable({
          stripePublishableKey,
          stripeSecretKey,
          stripeWebhookSecret,
          clearStripeSecretKey,
          clearStripeWebhookSecret,
        }, current)
        const previousSeller = getRuntimeCapabilities().sellerVatConfirmation?.enabled
          ? { companyName: current?.companyName, companyAddress: current?.companyAddress, countryCode: current?.countryCode,
              taxIds: await tx.organizationTaxId.findMany({ where: { organizationId: ctx.organizationId } }) }
          : undefined
        // Re-saving the stored provider is always fine; only switching to a new one is checked, so
        // capability changes on the server never block saving unrelated settings.
        if (settingsInput.aiProvider && settingsInput.aiProvider !== current?.aiProvider) {
          assertAiProviderAllowed(settingsInput.aiProvider)
        }
        const resolvedCountry = normalizeCountryCode(
          settingsInput.countryCode ?? current?.countryCode
        )
        if (isCloudDistribution && primaryTaxId !== undefined) {
          const stored = await tx.organizationTaxId.findFirst({ where: { organizationId: ctx.organizationId },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] })
          if (primaryTaxId.trim() !== stored?.value.trim() || (primaryTaxIdScheme?.trim() || "vat").toLowerCase() !== stored?.scheme.toLowerCase()) {
            await requireOnboardingCvr({ cvr: primaryTaxId.trim().replace(/^DK/, ""), scheme: primaryTaxIdScheme,
              cloud: true, userId: ctx.user.id, organizationId: ctx.organizationId })
          }
        }
        // Registration describes the Danish EU VAT setup, not a hidden cross-jurisdiction flag.
        const clearsRegistration = resolvedCountry !== "DK" || (settingsInput.taxRegime ?? current?.taxRegime) !== "eu_vat"
        if (clearsRegistration) settingsInput.momsRegistered = null
        if (settingsInput.momsRegistered === false && !isNonVatRegistrationAllowed()) {
          throw new TRPCError({ code: "FORBIDDEN", message: "save.failed" })
        }
        if (settingsInput.momsRegistered === false) {
          const primary = primaryTaxId?.trim()
            ? { scheme: primaryTaxIdScheme?.trim() || "vat", value: primaryTaxId, countryCode: resolvedCountry }
            : await tx.organizationTaxId.findFirst({ where: { organizationId: ctx.organizationId, isPrimary: true } })
          const scheme = primary?.scheme.trim().toLowerCase()
          const value = primary?.value.replace(/[\s.\-/]/g, "").toUpperCase().replace(/^DK/, "")
          if (!primary || (primary.countryCode && primary.countryCode !== "DK") ||
              !(isNationalRegistrationScheme(primary.scheme, "DK") || scheme === "vat" || scheme === "dk_vat") ||
              !value || !isValidDanishCvr(value)) {
            throw invalidCvr(settingsInput.locale ?? current?.locale)
          }
        }
        const effectiveRegistration = settingsInput.momsRegistered === undefined
          ? current?.momsRegistered
          : settingsInput.momsRegistered
        if (settingsInput.taxRate === undefined && settingsInput.countryCode && settingsInput.countryCode !== current?.countryCode) {
          settingsInput.taxRate = settingsInput.countryCode === "DK" ? 25 : null
        }
        if (!clearsRegistration && effectiveRegistration === false) settingsInput.taxRate = 0
        const localizedIssues = validateLocalizedFields(resolvedCountry, {
          phone: settingsInput.companyPhone,
          taxId: primaryTaxId,
        })
        if (resolvedCountry === "DK" && localizedIssues.taxId) throw invalidCvr(settingsInput.locale ?? current?.locale)
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

        const nextAiProvider = settingsInput.aiProvider ?? current?.aiProvider
        const nextAiBaseUrl = aiBaseUrl !== undefined ? aiBaseUrl || null : current?.aiBaseUrl
        if (nextAiProvider === "openai_compatible" && !nextAiBaseUrl) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Enter the base URL of the OpenAI-compatible endpoint",
          })
        }
        // Only a new destination is checked, so tightening the allowlist does not block saving
        // unrelated settings. A disallowed saved endpoint is still refused when drafting.
        if (aiDestinationChanged && aiBaseUrl && !isAiEndpointHostAllowed(aiBaseUrl)) {
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
          ...(clearsRegistration && current?.momsRegistered != null ? { paymentNote: localizedNonVatPaymentNote(current?.paymentNote, true) ?? null } : {}),
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

        await tx.orgSettings.upsert({
          where: { organizationId: ctx.organizationId },
          update: settingsUpdateData,
          create: { organizationId: ctx.organizationId, ...settingsUpdateData },
        })

        if (primaryTaxId && primaryTaxId.trim()) {
          const existing = await tx.organizationTaxId.findFirst({
            where: { organizationId: ctx.organizationId },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            select: { id: true, scheme: true, value: true, countryCode: true },
          })

          if (existing) {
            const nextScheme = primaryTaxIdScheme?.trim() || "vat"
            // Only the VAT paired with this Danish identity is derived from its edit. Keep foreign
            // and unrelated secondary identifiers, and never rewrite issued snapshots.
            if (resolvedCountry === "DK" && (!existing.countryCode || existing.countryCode === "DK") &&
                (isNationalRegistrationScheme(existing.scheme, "DK") || ["vat", "dk_vat"].includes(existing.scheme.toLowerCase())) &&
                (isNationalRegistrationScheme(nextScheme, "DK") || ["vat", "dk_vat"].includes(nextScheme.toLowerCase()))) {
              const registration = nationalRegistrationForScheme("cvr")!
              const oldCvr = registration.normalize(existing.value)
              const nextCvr = registration.normalize(primaryTaxId)
              if (/^\d{8}$/.test(oldCvr) && /^\d{8}$/.test(nextCvr)) await tx.organizationTaxId.updateMany({
                where: { organizationId: ctx.organizationId, value: `DK${oldCvr}`,
                  AND: [
                    { OR: [{ countryCode: "DK" }, { countryCode: null }] },
                    { OR: ["vat", "dk_vat"].map(scheme => ({ scheme: { equals: scheme, mode: "insensitive" as const } })) },
                  ],
                },
                data: { value: `DK${nextCvr}` },
              })
            }
            await tx.organizationTaxId.update({
              where: { id: existing.id },
              data: {
                value: primaryTaxId.trim(),
                scheme: primaryTaxIdScheme?.trim() || "vat",
                countryCode: nextScheme.toLowerCase() === "dk_vat" ? "DK" : resolvedCountry,
                isPrimary: true,
              },
            })
          } else {
            await tx.organizationTaxId.create({
              data: {
                organizationId: ctx.organizationId,
                value: primaryTaxId.trim(),
                scheme: primaryTaxIdScheme?.trim() || "vat",
                countryCode: primaryTaxIdScheme?.trim().toLowerCase() === "dk_vat" ? "DK" : resolvedCountry,
                isPrimary: true,
              },
            })
          }
        }

        if (resolvedCountry === "DK" && (await tx.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.organizationId } })).momsRegistered === false) {
          const primary = await tx.organizationTaxId.findFirst({
            where: { organizationId: ctx.organizationId, isPrimary: true },
          })
          const value = primary?.value.replace(/[\s.\-/]/g, "").toUpperCase()
          // Only a Danish eight-digit primary VAT identity can be reclassified as a CVR.
          if (primary && (!primary.countryCode || primary.countryCode === "DK") &&
              ["vat", "dk_vat"].includes(primary.scheme.toLowerCase()) && value && /^(DK)?\d{8}$/.test(value)) {
            await tx.organizationTaxId.update({
              where: { id: primary.id },
              data: { scheme: "cvr", value: value.replace(/^DK/, ""), countryCode: "DK" },
            })
          }
        }

        await confirmSellerVatStatus({ tx, organizationId: ctx.organizationId, userId: ctx.user.id, sessionId: ctx.session.session.id, request: ctx.request, registered: settingsInput.momsRegistered, token: sellerVatConfirmationToken, previousSettings: current, previousSeller })
        return tx.orgSettings.findUniqueOrThrow({ where: { organizationId: ctx.organizationId } })
      }, { timeout: 15_000 })
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

  /**
   * Calls the hosted Connect handler when one is registered. Does not create account
   * links or change the stored account.
   */
  runStripeConnectAction: authorizedProcedure("settings:update")
    .input(z.object({ action: z.enum(stripeConnectSettingsActions) }))
    .mutation(async ({ ctx, input }) => {
      const handler = getStripeConnectSettingsHandler()
      if (!getRuntimeCapabilities().payments.managed || !handler) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Stripe Connect actions are not available",
        })
      }
      try {
        const result = await handler.run(input.action, { organizationId: ctx.organizationId })
        return { url: stripeConnectRedirectUrl(result?.url) }
      } catch {
        appLogger.warn("settings.stripe_connect_action_failed", { organizationId: ctx.organizationId, action: input.action })
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not update Stripe Connect. Please try again." })
      }
    }),
})

/**
 * Managed payments refuse new Stripe key material. Resubmitting the stored publishable
 * key, omitting secrets, and clearing stored secrets stay allowed so Settings can still
 * be saved and legacy keys can be revoked. Self-hosted installs keep every field writable.
 */
function assertStripeByokWritable(input: {
  stripePublishableKey?: string
  stripeSecretKey?: string
  stripeWebhookSecret?: string
  clearStripeSecretKey?: boolean
  clearStripeWebhookSecret?: boolean
}, current: { stripePublishableKey: string | null } | null) {
  if (!usesStripeConnectCheckout()) return
  const publishableChanged =
    input.stripePublishableKey !== undefined &&
    input.stripePublishableKey !== (current?.stripePublishableKey ?? null)
  const writingNewSecrets = input.stripeSecretKey !== undefined || input.stripeWebhookSecret !== undefined
  if (!publishableChanged && !writingNewSecrets) return
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "Stripe keys cannot be saved while card payments are managed",
  })
}

function readStripeAccount(input: {
  managed: boolean
  accountId: string | null
  businessName: string | null
  status: OrgStripeAccount["status"]
  statusAt: Date | null
}): OrgStripeAccount {
  return orgStripeAccountSchema.parse({
    mode: input.managed ? "connect" : "byok",
    accountId: input.accountId,
    businessName: input.businessName,
    status: input.status,
    statusAt: input.statusAt?.toISOString() ?? null,
  })
}

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
  const sharedFromEmail = tryParseSenderAddress(environment.FROM_EMAIL ?? "")
  const sharedSender = sharedFromEmail === null ? null : resolveDocumentEmailEnvelope({
    orgName: input.settings.companyName,
    orgBillingEmail: input.settings.companyEmail,
    sharedFromEmail,
  })
  const brandedState = input.supportsCustomDomain
    ? readDocumentSendingDomainState(input.settings)
    : readDocumentSendingDomainState({})
  const effectiveSender = sharedFromEmail === null ? null : resolveDocumentEmailEnvelope({
    orgName: input.settings.companyName,
    orgBillingEmail: input.settings.companyEmail,
    sharedFromEmail,
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
