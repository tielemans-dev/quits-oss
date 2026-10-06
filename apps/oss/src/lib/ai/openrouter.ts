import { Cause, Data, Effect, Exit } from "effect"
import { z } from "zod"

const invoiceDraftItemSchema = z.object({
  description: z.string().trim().max(500).optional(),
  quantity: z.number().positive().max(1_000_000),
  unitPrice: z.number().min(0).max(1_000_000_000).optional(),
  catalogItemId: z.string().trim().min(1).max(100).optional(),
})

const invoiceDraftSchema = z.object({
  contactId: z.string().trim().min(1).max(100).optional(),
  contactName: z.string().trim().max(200).optional(),
  dueDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  notes: z.string().trim().max(5000).optional(),
  items: z.array(invoiceDraftItemSchema).min(1).max(100),
})

const openRouterChatCompletionResponseSchema = z.object({
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

const openRouterModelsResponseSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().optional(),
      })
    )
    .optional(),
})

export class OpenRouterNetworkError extends Data.TaggedError("OpenRouterNetworkError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export class OpenRouterHttpError extends Data.TaggedError("OpenRouterHttpError")<{
  readonly message: string
  readonly endpoint: string
  readonly status: number
  readonly body: string
}> {}

export class OpenRouterPayloadError extends Data.TaggedError("OpenRouterPayloadError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export class OpenRouterEmptyResponseError extends Data.TaggedError("OpenRouterEmptyResponseError")<{
  readonly message: string
}> {}

export type GeneratedInvoiceDraft = z.infer<typeof invoiceDraftSchema>

export const FALLBACK_OPENROUTER_MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4.1-mini",
  "anthropic/claude-3.5-sonnet",
  "google/gemini-2.0-flash-001",
]

export function extractJsonObjectFromText(text: string) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch?.[1]) {
    const fenced = fenceMatch[1].trim()
    if (fenced.startsWith("{") && fenced.endsWith("}")) {
      return fenced
    }
  }

  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1).trim()
  }

  return text.trim()
}

export function parseInvoiceDraftFromModelOutput(output: string): GeneratedInvoiceDraft {
  const jsonText = extractJsonObjectFromText(output)
  const parsed = JSON.parse(jsonText) as unknown
  return invoiceDraftSchema.parse(parsed)
}

function requestOpenRouterJson<T>({
  endpoint,
  apiKey,
  method,
  body,
  schema,
}: {
  endpoint: string
  apiKey: string
  method: "GET" | "POST"
  body?: string
  schema: z.ZodType<T>
}): Promise<T> {
  const url = `https://openrouter.ai/api/v1/${endpoint}`

  const program = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body } : {}),
        }),
      catch: (cause) =>
        new OpenRouterNetworkError({
          message: `OpenRouter ${endpoint} request failed`,
          cause,
        }),
    })

    if (!response.ok) {
      const errorBody = yield* Effect.promise(() => response.text().catch(() => ""))
      return yield* new OpenRouterHttpError({
        message: `OpenRouter ${endpoint} request failed (${response.status})`,
        endpoint,
        status: response.status,
        body: errorBody.slice(0, 500),
      })
    }

    const payload = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) =>
        new OpenRouterPayloadError({
          message: `OpenRouter ${endpoint} returned invalid JSON`,
          cause,
        }),
    })

    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      return yield* new OpenRouterPayloadError({
        message: `OpenRouter ${endpoint} returned an invalid payload shape`,
        cause: parsed.error,
      })
    }

    return parsed.data
  })

  return Effect.runPromiseExit(program).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return exit.value
    }

    throw Cause.squash(exit.cause)
  })
}

export async function generateInvoiceDraftWithOpenRouter(input: {
  apiKey: string
  model: string
  prompt: string
  todayIsoDate: string
  contacts: Array<{ id: string; name: string }>
  catalogItems: Array<{
    id: string
    name: string
    description?: string | null
    defaultUnitPrice: number
  }>
}) {
  const systemPrompt =
    `You generate structured invoice drafts. Today is ${input.todayIsoDate}. Resolve relative date phrases against today's date. Respond only as JSON object with keys: contactId?, contactName?, dueDate?(YYYY-MM-DD), taxRate?, notes?, items[]. Each item must include quantity, may include catalogItemId, description, and unitPrice. For description: include it only when the user gave concrete extra detail. Do not repeat the catalog item name as description. If uncertain about description, omit it. If a catalog item applies but the user did not specify a concrete price, omit unitPrice so system defaults can be applied.`

  const toolingContext = JSON.stringify(
    {
      availableContacts: input.contacts.slice(0, 200),
      availableCatalogItems: input.catalogItems.slice(0, 300),
    },
    null,
    2
  )

  const payload = await requestOpenRouterJson({
    endpoint: "chat/completions",
    apiKey: input.apiKey,
    method: "POST",
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "system", content: `Context JSON:\n${toolingContext}` },
        { role: "user", content: input.prompt },
      ],
      temperature: 0.2,
    }),
    schema: openRouterChatCompletionResponseSchema,
  })

  const output = payload.choices?.[0]?.message?.content
  if (!output?.trim()) {
    throw new OpenRouterEmptyResponseError({
      message: "OpenRouter returned an empty response",
    })
  }

  try {
    return parseInvoiceDraftFromModelOutput(output)
  } catch (cause) {
    throw new OpenRouterPayloadError({
      message: "OpenRouter returned an invoice draft that could not be parsed",
      cause,
    })
  }
}

export async function fetchOpenRouterModelIds(apiKey: string) {
  const payload = await requestOpenRouterJson({
    endpoint: "models",
    apiKey,
    method: "GET",
    schema: openRouterModelsResponseSchema,
  })

  const ids = (payload.data ?? [])
    .map((model) => model.id?.trim())
    .filter((id): id is string => Boolean(id))

  const uniqueSorted = Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b))
  return uniqueSorted
}
