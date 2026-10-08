import { readProductEnv } from "@quits/shared/runtimeEnv"
import { readOperationsHold } from "../operations-hold"
import { getRuntimeCapabilities } from "../runtime/extensions"
import { getRuntimeEnv } from "../runtime/platform"
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

/**
 * Asks for a JSON answer, optionally matching a JSON schema. A provider with structured output
 * should honour it; one without may ignore it, so the caller still parses the text leniently.
 */
export type AiResponseFormat = {
  type: "json"
  /** Short identifier for the schema, such as "invoice_draft". */
  name?: string
  /** JSON Schema the answer should match. Every key required and nullable, for strict modes. */
  schema?: Record<string, unknown>
}

export type AiCompletionRequest = {
  model: string
  messages: AiChatMessage[]
  /** A provider may leave it out for models that do not take a temperature. */
  temperature?: number
  responseFormat?: AiResponseFormat
}

export type AiProvider = {
  /** Stable identifier reported back to the client, such as "openrouter". */
  id: AiProviderKind | "managed"
  /** Returns the model's text output. Throws an `AiProviderError` on failure. */
  complete: (request: AiCompletionRequest) => Promise<string>
  /** Lists selectable model ids. Absent when the provider has no model list. */
  listModels?: () => Promise<string[]>
  /**
   * Model to request when the organisation's saved model does not apply. A managed provider sets
   * this, because the saved model was chosen for the organisation's own provider.
   */
  defaultModel?: string
}

/** Provider kinds an organisation can choose in settings. Stored in `OrgSettings.aiProvider`. */
export const AI_PROVIDER_KINDS = ["openrouter", "openai_compatible", "cli_agent"] as const
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number]

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
export const DEFAULT_AI_MODEL = "openai/gpt-4o-mini"

export function isAiProviderKind(value: unknown): value is AiProviderKind {
  return typeof value === "string" && (AI_PROVIDER_KINDS as readonly string[]).includes(value)
}

/**
 * Whether the operator allows custom AI endpoints on this URL's host.
 *
 * `AI_CUSTOM_ENDPOINT_HOSTS` is a comma-separated list of hosts, optionally with a port
 * (`localhost:11434, llm.internal`). When it is unset, any host is allowed: on a single-organisation
 * install the admin is the operator. Set it on shared installs, where organisation admins must not
 * make the server send requests to arbitrary addresses.
 */
export function isAiEndpointHostAllowed(
  baseUrl: string,
  env: Record<string, string | undefined> = getRuntimeEnv()
) {
  const allowed = (readProductEnv(env, "AI_CUSTOM_ENDPOINT_HOSTS") ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  if (allowed.length === 0) {
    return true
  }
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  // `URL` drops a protocol's default port, so `https://host:443` has host `host`. Treat an entry
  // naming the default port the same as the bare host.
  const defaultPort = url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : ""
  const hostname = url.hostname.toLowerCase()
  const candidates = new Set([hostname, url.host.toLowerCase()])
  if (!url.port && defaultPort) {
    candidates.add(`${hostname}:${defaultPort}`)
  }
  return allowed.some((entry) => candidates.has(entry))
}

export type AiProviderErrorCode =
  | "not_configured"
  | "disabled"
  | "network"
  | "http"
  | "invalid_response"
  | "empty_response"
  | "timeout"
  | "busy"
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
  return withoutOperationsHold(resolveUnguardedOrgAiProvider(settings))
}

function resolveUnguardedOrgAiProvider(settings: OrgAiSettings): AiProvider {
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
      if (!isAiEndpointHostAllowed(settings.baseUrl)) {
        throw disabled(settings.provider, "This AI endpoint's host is not allowed on this server")
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
  return withoutOperationsHold(provider)
}

/**
 * A held installation (see `lib/operations-hold`) makes no AI requests: they leave the machine,
 * may cost money, and a restored copy must not act as the original.
 */
function withoutOperationsHold(provider: AiProvider): AiProvider {
  const assertLive = async () => {
    const hold = await readOperationsHold()
    if (hold.held) {
      throw disabled(provider.id, `Operations are on hold, so AI requests are disabled. ${hold.reason}`)
    }
  }
  return {
    ...provider,
    complete: async (request) => {
      await assertLive()
      return provider.complete(request)
    },
    ...(provider.listModels
      ? {
          listModels: async () => {
            await assertLive()
            return provider.listModels!()
          },
        }
      : {}),
  }
}

function disabled(providerId: string, message: string) {
  return new AiProviderError({ code: "disabled", providerId, message })
}
