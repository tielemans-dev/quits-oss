import { z } from "zod"
import { type AiProvider, AiProviderError } from "./provider"

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

export type GeneratedInvoiceDraft = z.infer<typeof invoiceDraftSchema>

export const FALLBACK_AI_MODELS = [
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

/**
 * Asks the organisation's AI provider to draft an invoice from a natural-language prompt.
 * Throws `AiProviderError` (`invalid_response`) when the model output is not a usable draft.
 */
export async function generateInvoiceDraft(input: {
  provider: AiProvider
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
}): Promise<GeneratedInvoiceDraft> {
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

  const output = await input.provider.complete({
    model: input.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "system", content: `Context JSON:\n${toolingContext}` },
      { role: "user", content: input.prompt },
    ],
    temperature: 0.2,
  })

  try {
    return parseInvoiceDraftFromModelOutput(output)
  } catch (cause) {
    throw new AiProviderError({
      code: "invalid_response",
      providerId: input.provider.id,
      message: "The AI model returned an invoice draft that could not be parsed",
      cause,
    })
  }
}
