import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { FALLBACK_AI_MODELS, generateInvoiceDraft } from "../../lib/ai/invoice-draft"
import {
  AiProviderError,
  DEFAULT_AI_MODEL,
  isAiProviderKind,
  resolveManagedAiProvider,
  resolveOrgAiProvider,
  type AiProvider,
  type OrgAiSettings,
} from "../../lib/ai/provider"
// Side effect: registers the concrete provider factories before any provider is resolved.
import "../../lib/ai/providers"
import { resolveDraftItemDescription } from "../../lib/ai/description"
import { resolveCatalogItemId, resolveContactId } from "../../lib/ai/matching"
import { resolveInvoiceDueDate } from "../../lib/ai/due-date"
import { resolveDraftItemUnitPrice } from "../../lib/ai/pricing"
import { prisma } from "../../lib/db"
import { decryptSecret } from "../../lib/secrets"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { getBillingProvider } from "../../lib/runtime/services"
import { authorizedProcedure, router } from "../init"

const aiGenerateInvoiceDraftInputSchema = z.object({
  prompt: z.string().trim().min(10).max(4000),
  mode: z.enum(["byok", "managed"]).default("byok"),
})

/**
 * Loads the organisation's AI settings with the API key decrypted. An unknown stored provider
 * falls back to OpenRouter, the default before providers were configurable.
 */
async function readOrgAiSettings(organizationId: string): Promise<OrgAiSettings> {
  const row = await prisma.orgSettings.findUnique({
    where: { organizationId },
    select: { aiProvider: true, aiBaseUrl: true, aiApiKeyEnc: true, aiModel: true },
  })

  let apiKey: string | null = null
  if (row?.aiApiKeyEnc) {
    try {
      apiKey = decryptSecret(row.aiApiKeyEnc)
    } catch {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Unable to decrypt the AI API key. Re-save it in Settings.",
      })
    }
  }

  const storedProvider = row?.aiProvider
  return {
    provider: isAiProviderKind(storedProvider) ? storedProvider : "openrouter",
    baseUrl: row?.aiBaseUrl ?? null,
    apiKey,
    model: row?.aiModel || DEFAULT_AI_MODEL,
  }
}

function uniqueModelIds(ids: Array<string | null | undefined>) {
  return Array.from(new Set(ids.filter((id): id is string => Boolean(id))))
}

/**
 * Maps a provider failure to the tRPC error the client shows. Setup problems carry our own
 * messages. Upstream failures can embed endpoint responses or agent stderr, so those details are
 * logged on the server and the client gets a generic message.
 */
function toTrpcAiError(error: AiProviderError) {
  if (error.code === "disabled" || error.code === "not_configured") {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: error.message, cause: error })
  }
  console.error(`[ai] ${error.providerId} request failed (${error.code}): ${error.message}`)
  if (error.code === "busy") {
    return new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "The AI provider is busy. Try again in a moment.",
      cause: error,
    })
  }
  return new TRPCError({
    code: "BAD_GATEWAY",
    message:
      error.code === "timeout"
        ? "The AI provider did not respond in time"
        : "The AI provider request failed",
    cause: error,
  })
}

export const aiRouter = router({
  listModels: authorizedProcedure("settings:read").query(async ({ ctx }) => {
    // The built-in list holds OpenRouter ids; a custom endpoint only gets its current model.
    const fallback = () => ({
      models: uniqueModelIds(
        settings?.provider === "openai_compatible"
          ? [currentModel]
          : [...FALLBACK_AI_MODELS, currentModel]
      ),
      source: "fallback" as const,
    })

    let settings: OrgAiSettings | undefined
    let currentModel = DEFAULT_AI_MODEL
    try {
      settings = await readOrgAiSettings(ctx.organizationId)
      currentModel = settings.model
    } catch {
      return { models: uniqueModelIds([...FALLBACK_AI_MODELS]), source: "fallback" as const }
    }

    // CLI agents choose their own model; there is no list to offer.
    if (settings.provider === "cli_agent") {
      return { models: [], source: "none" as const }
    }

    let provider: AiProvider
    try {
      provider = resolveOrgAiProvider(settings)
    } catch {
      return fallback()
    }
    if (!provider.listModels) {
      return fallback()
    }

    try {
      const modelIds = await provider.listModels()
      return {
        models: uniqueModelIds([currentModel, ...modelIds]),
        source: "provider" as const,
      }
    } catch {
      return fallback()
    }
  }),

  generateInvoiceDraft: authorizedProcedure("invoice:create")
    .input(aiGenerateInvoiceDraftInputSchema)
    .mutation(async ({ ctx, input }) => {
      const now = new Date()
      const todayIsoDate = now.toISOString().slice(0, 10)

      const capabilities = getRuntimeCapabilities()
      if (!capabilities.aiInvoiceDraft.enabled) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "AI invoice drafting is disabled",
        })
      }

      // The organisation's saved model was chosen for its own provider, so the managed provider
      // always uses its own default model.
      const useManaged = async () => {
        let managed: AiProvider
        try {
          managed = resolveManagedAiProvider()
        } catch (error) {
          if (error instanceof AiProviderError) throw toTrpcAiError(error)
          throw error
        }
        if (capabilities.aiInvoiceDraft.managedRequiresSubscription) {
          const subscription = await getBillingProvider().getSubscription(ctx.organizationId)
          if (subscription.status !== "active") {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "Managed AI needs an active subscription",
            })
          }
        }
        return { provider: managed, model: managed.defaultModel ?? DEFAULT_AI_MODEL }
      }

      let provider: AiProvider
      let model: string
      if (input.mode === "managed") {
        ;({ provider, model } = await useManaged())
      } else {
        const settings = await readOrgAiSettings(ctx.organizationId)
        model = settings.model
        try {
          provider = resolveOrgAiProvider(settings)
        } catch (error) {
          if (!(error instanceof AiProviderError)) throw error
          // An organisation whose own provider is not set up, or no longer allowed, uses the
          // distribution's managed provider when one is available.
          if (
            (error.code !== "not_configured" && error.code !== "disabled") ||
            !capabilities.aiInvoiceDraft.managed
          ) {
            throw toTrpcAiError(error)
          }
          ;({ provider, model } = await useManaged())
        }
      }

      const [contacts, catalogItems] = await Promise.all([
        prisma.contact.findMany({
          where: { organizationId: ctx.organizationId },
          select: { id: true, name: true },
          take: 200,
          orderBy: { createdAt: "desc" },
        }),
        prisma.catalogItem.findMany({
          where: { organizationId: ctx.organizationId, isActive: true },
          select: { id: true, name: true, description: true, defaultUnitPrice: true },
          take: 300,
          orderBy: { createdAt: "desc" },
        }),
      ])

      const catalogItemsWithDefaults = catalogItems.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        defaultUnitPrice: item.defaultUnitPrice.toNumber(),
      }))
      const catalogDefaultsById = new Map(
        catalogItemsWithDefaults.map((item) => [item.id, item.defaultUnitPrice])
      )
      const catalogItemsById = new Map(
        catalogItemsWithDefaults.map((item) => [
          item.id,
          { name: item.name, description: item.description },
        ])
      )

      let draft: Awaited<ReturnType<typeof generateInvoiceDraft>>
      try {
        draft = await generateInvoiceDraft({
          provider,
          model,
          prompt: input.prompt,
          todayIsoDate,
          contacts,
          catalogItems: catalogItemsWithDefaults,
        })
      } catch (error) {
        if (error instanceof AiProviderError) throw toTrpcAiError(error)
        throw error
      }

      const resolvedContactId = resolveContactId({
        requestedContactId: draft.contactId,
        requestedContactName: draft.contactName,
        contacts,
      })

      const resolvedItems = draft.items.map((item) => {
        const resolvedCatalogItemId = resolveCatalogItemId({
          requestedCatalogItemId: item.catalogItemId,
          description: item.description,
          catalogItems: catalogItemsWithDefaults,
        })

        return {
          ...item,
          description: resolveDraftItemDescription({
            requestedDescription: item.description,
            resolvedCatalogItemId,
            catalogItemsById,
          }),
          unitPrice: resolveDraftItemUnitPrice({
            requestedUnitPrice: item.unitPrice,
            resolvedCatalogItemId,
            catalogDefaultsById,
          }),
          catalogItemId: resolvedCatalogItemId,
        }
      })

      return {
        mode: input.mode,
        provider: provider.id,
        model,
        draft: {
          ...draft,
          dueDate: resolveInvoiceDueDate({
            prompt: input.prompt,
            modelDueDate: draft.dueDate,
            now,
          }),
          contactId: resolvedContactId,
          items: resolvedItems,
        },
      }
    }),
})
