import { getRuntimeCapabilities } from "../runtime/extensions"
import { getManagedAiProvider } from "../runtime/services"

/**
 * One text-completion backend used by in-app AI features.
 *
 * Features build their prompt as messages and parse the returned text themselves, so a
 * provider only has to turn messages into text. Providers never get tool access.
 */
export type AiChatMessage = {
  role: "system" | "user"
  content: string
}

export type AiCompletionRequest = {
  model: string
  messages: AiChatMessage[]
  temperature?: number
}

export type AiProvider = {
  /** Stable identifier reported back to the client, such as "openrouter". */
  id: AiProviderKind | "managed"
  /** Returns the model's text output. Throws an `AiProviderError` on failure. */
  complete: (request: AiCompletionRequest) => Promise<string>
  /** Lists selectable model ids. Absent when the provider has no model list. */
  listModels?: () => Promise<string[]>
}

/** Provider kinds an organisation can choose in settings. Stored in `OrgSettings.aiProvider`. */
export const AI_PROVIDER_KINDS = ["openrouter", "openai_compatible", "cli_agent"] as const
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number]

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
export const DEFAULT_AI_MODEL = "openai/gpt-4o-mini"

export function isAiProviderKind(value: unknown): value is AiProviderKind {
  return typeof value === "string" && (AI_PROVIDER_KINDS as readonly string[]).includes(value)
}

export type AiProviderErrorCode =
  | "not_configured"
  | "disabled"
  | "network"
  | "http"
  | "invalid_response"
  | "empty_response"
  | "timeout"
  | "process_failed"

export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode
  readonly providerId: string

  constructor(input: {
    code: AiProviderErrorCode
    providerId: string
    message: string
    cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "AiProviderError"
    this.code = input.code
    this.providerId = input.providerId
  }
}

/** The organisation's saved AI settings, with the API key already decrypted. */
export type OrgAiSettings = {
  provider: AiProviderKind
  baseUrl: string | null
  apiKey: string | null
  model: string
}

type ProviderFactories = {
  openaiCompatible: (input: {
    id: "openrouter" | "openai_compatible"
    baseUrl: string
    apiKey: string | null
  }) => AiProvider
  cliAgent: () => AiProvider
}

let providerFactories: ProviderFactories | null = null

/**
 * Registers the concrete provider implementations. Called once from
 * `lib/ai/providers/index.ts`; kept separate so this module stays free of Node-only imports.
 */
export function registerAiProviderFactories(factories: ProviderFactories) {
  providerFactories = factories
}

/**
 * Resolves the provider for an organisation, enforcing the runtime capabilities.
 *
 * Throws `AiProviderError` with code `disabled` when the distribution does not allow the
 * chosen provider, and `not_configured` when required settings are missing.
 */
export function resolveOrgAiProvider(settings: OrgAiSettings): AiProvider {
  const capabilities = getRuntimeCapabilities().aiInvoiceDraft
  if (!providerFactories) {
    throw new AiProviderError({
      code: "not_configured",
      providerId: settings.provider,
      message: "AI providers are not registered",
    })
  }

  switch (settings.provider) {
    case "openrouter": {
      if (!capabilities.byok) {
        throw disabled(settings.provider, "BYOK AI is disabled for this distribution")
      }
      if (!settings.apiKey) {
        throw new AiProviderError({
          code: "not_configured",
          providerId: settings.provider,
          message: "Set your OpenRouter API key in Settings before using AI",
        })
      }
      return providerFactories.openaiCompatible({
        id: "openrouter",
        baseUrl: OPENROUTER_BASE_URL,
        apiKey: settings.apiKey,
      })
    }
    case "openai_compatible": {
      if (!capabilities.byok || !capabilities.customEndpoint) {
        throw disabled(settings.provider, "Custom AI endpoints are disabled for this distribution")
      }
      if (!settings.baseUrl) {
        throw new AiProviderError({
          code: "not_configured",
          providerId: settings.provider,
          message: "Set the AI endpoint base URL in Settings before using AI",
        })
      }
      return providerFactories.openaiCompatible({
        id: "openai_compatible",
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
      })
    }
    case "cli_agent": {
      if (!capabilities.localAgent) {
        throw disabled(settings.provider, "The local agent is not enabled on this server")
      }
      return providerFactories.cliAgent()
    }
  }
}

/** The hosted distribution's managed provider, when one is registered and enabled. */
export function resolveManagedAiProvider(): AiProvider {
  const provider = getManagedAiProvider()
  if (!getRuntimeCapabilities().aiInvoiceDraft.managed || !provider) {
    throw disabled("managed", "Managed AI is not enabled for this distribution")
  }
  return provider
}

function disabled(providerId: string, message: string) {
  return new AiProviderError({ code: "disabled", providerId, message })
}
