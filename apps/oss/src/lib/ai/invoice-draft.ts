import { z } from "zod"
import { type AiProvider, AiProviderError } from "./provider"

/**
 * Reads a number the model wrote, either as a JSON number or as text such as "5.000 kr",
 * "5,000.50" or "1.234,5". A dot or comma followed by exactly three digits is read as a thousands
 * separator, so "5.000" is 5000, as a Danish user means it. Anything unreadable is `undefined`.
 */
export function readModelNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  // Drops currency, spaces and the Danish ",-" that marks a whole amount.
  const trimmed = value.trim().replace(/[.,]-$/, "")
  const negative = /^-|^[^\d]*-\s*\d/.test(trimmed)
  let text = trimmed.replace(/[^\d.,]/g, "").replace(/^[.,]+|[.,]+$/g, "")
  if (!/\d/.test(text)) return undefined
  const lastDot = text.lastIndexOf(".")
  const lastComma = text.lastIndexOf(",")
  if (lastDot >= 0 && lastComma >= 0) {
    // Both appear: the later one is the decimal separator.
    const decimal = lastDot > lastComma ? "." : ","
    const thousands = decimal === "." ? "," : "."
    text = text.split(thousands).join("").replace(decimal, ".")
  } else {
    const separator = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null
    if (separator) {
      const groups = text.split(separator)
      const isThousands =
        groups.length > 2 || (groups.length === 2 && groups[1]!.length === 3 && groups[0] !== "0")
      text = isThousands ? groups.join("") : groups.join(".")
    }
  }
  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return undefined
  return negative ? -parsed : parsed
}

/** A missing, null or unusable optional field reads as absent instead of failing the draft. */
function lenient<T extends z.ZodTypeAny>(schema: T) {
  return z.unknown().transform((value) => {
    const result = schema.safeParse(value)
    return result.success ? (result.data as z.output<T>) : undefined
  })
}

function text(maxLength: number) {
  return lenient(
    z
      .string()
      .trim()
      .transform((value) => value.slice(0, maxLength))
      .refine((value) => value.length > 0)
  )
}

function number(check: (value: number) => boolean) {
  return z.unknown().transform((value) => {
    const parsed = readModelNumber(value)
    return parsed !== undefined && check(parsed) ? parsed : undefined
  })
}

const invoiceDraftItemSchema = z
  .object({
    description: text(500),
    // Models also use these names for the line text and price.
    name: text(500),
    quantity: number((value) => value > 0 && value <= 1_000_000),
    unitPrice: number((value) => value >= 0 && value <= 1_000_000_000),
    price: number((value) => value >= 0 && value <= 1_000_000_000),
    catalogItemId: text(100),
  })
  .transform(({ name, price, ...item }) =>
    dropUndefined({
      description: item.description ?? name,
      // A line the model gave no quantity for is one of it.
      quantity: item.quantity ?? 1,
      unitPrice: item.unitPrice ?? price,
      catalogItemId: item.catalogItemId,
    })
  )

const invoiceDraftSchema = z
  .object({
    contactId: text(100),
    contactName: text(200),
    dueDate: lenient(z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/)),
    taxRate: number((value) => value >= 0 && value <= 100),
    notes: text(5000),
    items: z.array(z.unknown()).min(1).max(100),
  })
  .transform(({ items, ...draft }) => ({
    ...dropUndefined(draft),
    items: items.flatMap((item) => {
      const result = invoiceDraftItemSchema.safeParse(item)
      return result.success ? [result.data] : []
    }),
  }))
  .refine((draft) => draft.items.length > 0, { message: "No usable invoice items" })

function dropUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as { [K in keyof T]?: Exclude<T[K], undefined> }
}

export type GeneratedInvoiceDraft = {
  contactId?: string
  contactName?: string
  dueDate?: string
  taxRate?: number
  notes?: string
  items: Array<{
    description?: string
    quantity: number
    unitPrice?: number
    catalogItemId?: string
  }>
}

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
  let parsed = JSON.parse(jsonText) as unknown
  // Some models wrap the draft in one more object, such as `{"invoice": {...}}`.
  if (isRecord(parsed) && !("items" in parsed)) {
    const nested = Object.values(parsed).find((value) => isRecord(value) && "items" in value)
    if (nested) parsed = nested
  }
  return invoiceDraftSchema.parse(parsed) as GeneratedInvoiceDraft
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
  const systemPrompt = [
    `You generate structured invoice drafts. Today is ${input.todayIsoDate}. Resolve relative date phrases against today's date.`,
    "Respond with one JSON object only, no prose and no markdown, with keys: contactId?, contactName?, dueDate? (YYYY-MM-DD), taxRate?, notes?, items[]. Leave out any key you have no value for; never use null.",
    "Each item must include quantity, may include catalogItemId, description, and unitPrice. Write quantity, unitPrice and taxRate as plain JSON numbers without thousands separators or currency: \"5.000 kroner\" is 5000.",
    "The user may write in any language and may include text unrelated to the invoice; ignore that text and draft from what was sold. When the user names a price per item and a count, use the count as quantity and the price as unitPrice. Always return at least one item.",
    "Only use a contactId or catalogItemId from the context JSON. For description: include it only when the user gave concrete extra detail. Do not repeat the catalog item name as description. If uncertain about description, omit it. If a catalog item applies but the user did not specify a concrete price, omit unitPrice so system defaults can be applied.",
  ].join(" ")

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
      message: `The AI model returned an invoice draft that could not be parsed: ${describeParseFailure(cause)}`,
      cause,
    })
  }
}

/**
 * Says why a draft did not parse without quoting the model output, which can repeat the user's
 * prompt and customer details.
 */
function describeParseFailure(cause: unknown) {
  if (cause instanceof SyntaxError) return "the output is not JSON"
  if (cause instanceof z.ZodError) {
    return cause.issues
      .map((issue) => `${issue.path.join(".") || "draft"}: ${issue.message}`)
      .join("; ")
  }
  return "unknown reason"
}
