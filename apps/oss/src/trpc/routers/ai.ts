import { TRPCError } from "@trpc/server"
import { z } from "zod"
import {
  FALLBACK_OPENROUTER_MODELS,
  fetchOpenRouterModelIds,
  generateInvoiceDraftWithOpenRouter,
} from "../../lib/ai/openrouter"
import { resolveDraftItemDescription } from "../../lib/ai/description"
import { resolveCatalogItemId, resolveContactId } from "../../lib/ai/matching"
import { resolveInvoiceDueDate } from "../../lib/ai/due-date"
import { resolveDraftItemUnitPrice } from "../../lib/ai/pricing"
import { prisma } from "../../lib/db"
import { decryptSecret } from "../../lib/secrets"
import { getRuntimeCapabilities } from "../../lib/runtime/extensions"
import { authorizedProcedure, router } from "../init"

const aiGenerateInvoiceDraftInputSchema = z.object({
  prompt: z.string().trim().min(10).max(4000),
  mode: z.enum(["byok", "managed"]).default("byok"),
})

export const aiRouter = router({
  listModels: authorizedProcedure("settings:read").query(async ({ ctx }) => {
    const capabilities = getRuntimeCapabilities()
    if (!capabilities.aiInvoiceDraft.byok) {
      return { models: FALLBACK_OPENROUTER_MODELS, source: "fallback" as const }
    }

    const settings = await prisma.orgSettings.findUnique({
      where: { organizationId: ctx.organizationId },
      select: { aiOpenRouterApiKeyEnc: true, aiOpenRouterModel: true },
    })

    if (!settings?.aiOpenRouterApiKeyEnc) {
      return {
        models: Array.from(
          new Set([...(FALLBACK_OPENROUTER_MODELS || []), settings?.aiOpenRouterModel || ""])
        ).filter(Boolean),
        source: "fallback" as const,
      }
    }

    const apiKey = decryptSecret(settings.aiOpenRouterApiKeyEnc)
    const modelIds = await fetchOpenRouterModelIds(apiKey)
    const withCurrent = settings.aiOpenRouterModel
      ? Array.from(new Set([settings.aiOpenRouterModel, ...modelIds]))
      : modelIds

    return {
      models: withCurrent,
      source: "openrouter" as const,
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

      if (input.mode === "managed") {
        if (!capabilities.aiInvoiceDraft.managed) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Managed AI is not enabled for this distribution",
          })
        }
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Managed AI billing flow is not configured yet",
        })
      }

      if (!capabilities.aiInvoiceDraft.byok) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "BYOK AI is disabled for this distribution",
        })
      }

      const settings = await prisma.orgSettings.findUnique({
        where: { organizationId: ctx.organizationId },
        select: {
          aiOpenRouterApiKeyEnc: true,
          aiOpenRouterModel: true,
        },
      })

      if (!settings?.aiOpenRouterApiKeyEnc) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Set your OpenRouter API key in Settings before using AI draft generation",
        })
      }

      let apiKey: string
      try {
        apiKey = decryptSecret(settings.aiOpenRouterApiKeyEnc)
      } catch {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Unable to decrypt OpenRouter key. Re-save your API key in Settings.",
        })
      }

      const model = settings.aiOpenRouterModel || "openai/gpt-4o-mini"
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

      const draft = await generateInvoiceDraftWithOpenRouter({
        apiKey,
        model,
        prompt: input.prompt,
        todayIsoDate,
        contacts,
        catalogItems: catalogItemsWithDefaults,
      })

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
        mode: "byok" as const,
        provider: "openrouter" as const,
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
