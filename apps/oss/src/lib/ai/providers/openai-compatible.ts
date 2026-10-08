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
  }): Promise<T> {
    const url = `${baseUrl}/${options.endpoint}`
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
      response = await fetch(url, { method: options.method, headers, body })
    } catch (cause) {
      throw new AiProviderError({
        code: "network",
        providerId: input.id,
        message: `${providerName} ${options.endpoint} request failed`,
        cause,
      })
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "")
      throw new AiProviderError({
        code: "http",
        providerId: input.id,
        message: `${providerName} ${options.endpoint} request failed (${response.status}): ${errorBody.slice(0, 500)}`,
      })
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      throw new AiProviderError({
        code: "invalid_response",
        providerId: input.id,
        message: `${providerName} ${options.endpoint} returned invalid JSON`,
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
