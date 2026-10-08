import { z } from "zod"
import { type AiCompletionRequest, type AiProvider, AiProviderError } from "../provider"

const chatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().optional(),
          })
          .optional(),
      })
    )
    .optional(),
})

const modelsResponseSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().optional(),
      })
    )
    .optional(),
})

/**
 * Provider for any endpoint that speaks the OpenAI chat-completions protocol: OpenRouter, Ollama,
 * LM Studio, vLLM and similar servers. `baseUrl` is the API root, for example
 * `https://openrouter.ai/api/v1`.
 */
// A slow local model can take a while to draft; a model list should be quick.
const COMPLETION_TIMEOUT_MS = 120_000
const MODELS_TIMEOUT_MS = 15_000

// A completion or model list is small. The caps keep a broken or hostile endpoint from making the
// server buffer an unbounded body.
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024
const ERROR_BODY_MAX_BYTES = 16 * 1024

class ResponseTooLargeError extends Error {}

/** Reads a response body as text, stopping with an error once it exceeds `maxBytes`. */
async function readCappedText(response: Response, maxBytes: number) {
  if (!response.body) {
    return ""
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new ResponseTooLargeError(`Response body exceeds ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(concatChunks(chunks, total))
}

function concatChunks(chunks: Uint8Array[], total: number) {
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Appends a route to the base URL's path, keeping any query string (for example `?api-version=`). */
export function endpointUrl(baseUrl: string, endpoint: string) {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${endpoint}`
  url.hash = ""
  return url.toString()
}

export function createOpenAiCompatibleProvider(input: {
  id: "openrouter" | "openai_compatible"
  baseUrl: string
  apiKey: string | null
}): AiProvider {
  const baseUrl = input.baseUrl.replace(/\/+$/, "")
  const providerName = input.id === "openrouter" ? "OpenRouter" : "AI endpoint"

  async function requestJson<T>(options: {
    endpoint: string
    method: "GET" | "POST"
    body?: unknown
    schema: z.ZodType<T>
    /** Covers the whole exchange, including a slow body: the signal also aborts reading it. */
    timeoutMs: number
  }): Promise<T> {
    const url = endpointUrl(baseUrl, options.endpoint)
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)

    const headers: Record<string, string> = {}
    if (input.apiKey !== null) {
      headers.Authorization = `Bearer ${input.apiKey}`
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json"
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
        // A redirect could lead to a host the operator has not allowed, so none are followed.
        redirect: "manual",
      })
    } catch (cause) {
      if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
        throw new AiProviderError({
          code: "timeout",
          providerId: input.id,
          message: `${providerName} ${options.endpoint} did not respond within ${options.timeoutMs / 1000} seconds`,
          cause,
        })
      }
      throw new AiProviderError({
        code: "network",
        providerId: input.id,
        message: `${providerName} ${options.endpoint} request failed`,
        cause,
      })
    }

    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new AiProviderError({
        code: "http",
        providerId: input.id,
        message: `${providerName} ${options.endpoint} answered with a redirect (${response.status}); redirects are not followed. Use the final URL as the base URL`,
      })
    }

    if (!response.ok) {
      const errorBody = await readCappedText(response, ERROR_BODY_MAX_BYTES).catch(() => "")
      throw new AiProviderError({
        code: "http",
        providerId: input.id,
        message: `${providerName} ${options.endpoint} request failed (${response.status}): ${errorBody.slice(0, 500)}`,
      })
    }

    let payload: unknown
    try {
      payload = JSON.parse(await readCappedText(response, RESPONSE_MAX_BYTES))
    } catch (cause) {
      throw new AiProviderError({
        code: "invalid_response",
        providerId: input.id,
        message:
          cause instanceof ResponseTooLargeError
            ? `${providerName} ${options.endpoint} returned more than ${RESPONSE_MAX_BYTES} bytes`
            : `${providerName} ${options.endpoint} returned invalid JSON`,
        cause,
      })
    }

    const parsed = options.schema.safeParse(payload)
    if (!parsed.success) {
      throw new AiProviderError({
        code: "invalid_response",
        providerId: input.id,
        message: `${providerName} ${options.endpoint} returned an invalid payload shape`,
        cause: parsed.error,
      })
    }

    return parsed.data
  }

  return {
    id: input.id,

    async complete(request: AiCompletionRequest) {
      const payload = await requestJson({
        endpoint: "chat/completions",
        timeoutMs: COMPLETION_TIMEOUT_MS,
        method: "POST",
        body: {
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
        },
        schema: chatCompletionResponseSchema,
      })

      const content = payload.choices?.[0]?.message?.content
      if (!content?.trim()) {
        throw new AiProviderError({
          code: "empty_response",
          providerId: input.id,
          message: `${providerName} returned an empty response`,
        })
      }

      return content
    },

    async listModels() {
      const payload = await requestJson({
        endpoint: "models",
        timeoutMs: MODELS_TIMEOUT_MS,
        method: "GET",
        schema: modelsResponseSchema,
      })

      const ids = (payload.data ?? [])
        .map((model) => model.id?.trim())
        .filter((id): id is string => Boolean(id))

      return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b))
    },
  }
}
