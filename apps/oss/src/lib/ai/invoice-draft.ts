import { type AiProvider, AiProviderError, type AiResponseFormat } from "./provider"

export type GeneratedInvoiceDraft = {
  contactId?: string
  contactName?: string
  dueDate?: string
  taxRate?: number
  notes?: string
  /**
   * Why the model drafted no items, in the user's language. Set when `items` is empty because the
   * prompt describes nothing that was sold.
   */
  reason?: string
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

const nullable = (type: string) => ({ type: [type, "null"] })

/**
 * The draft's JSON schema, for providers with structured output. Every key is required and
 * nullable, as strict schema modes demand; the parser reads null as absent.
 */
export const INVOICE_DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["contactId", "contactName", "dueDate", "taxRate", "notes", "reason", "items"],
  properties: {
    contactId: nullable("string"),
    contactName: nullable("string"),
    dueDate: { ...nullable("string"), description: "YYYY-MM-DD" },
    taxRate: { ...nullable("number"), description: "Percent, such as 25" },
    notes: nullable("string"),
    reason: {
      ...nullable("string"),
      description: "Only when items is empty: why, in the user's language",
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "quantity", "unitPrice", "catalogItemId"],
        properties: {
          description: nullable("string"),
          quantity: { type: "number" },
          unitPrice: nullable("number"),
          catalogItemId: nullable("string"),
        },
      },
    },
  },
} as const

const INVOICE_DRAFT_RESPONSE_FORMAT: AiResponseFormat = {
  type: "json",
  name: "invoice_draft",
  schema: INVOICE_DRAFT_JSON_SCHEMA,
}

const CURRENCY = String.raw`(?:kroner|kronor|euro|dollars?|kr\.?|dkk|eur|usd|gbp|sek|nok|[$€£])`
const LEADING_UNIT = new RegExp(String.raw`^(?:${CURRENCY}\s*)+`, "i")
const TRAILING_UNIT = new RegExp(String.raw`(?:\s*(?:${CURRENCY}|%|[.,]-))+$`, "i")

/**
 * Reads a number the model wrote, either as a JSON number or as text such as "5.000 kr",
 * "5,000.50" or "1.234,50". A single dot or comma followed by exactly three digits is a thousands
 * separator, so "5.000" is 5000, as a Danish user means it. Text that is not one plain amount,
 * such as "5-10", "3 x 500" or "5k", is `undefined` rather than a guess.
 */
export function readModelNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const text = value
    .trim()
    .replace(/−/g, "-")
    .replace(LEADING_UNIT, "")
    .replace(TRAILING_UNIT, "")
    .trim()

  const single = text.match(/^(-?)(\d+)(?:([.,])(\d+))?$/)
  if (single) {
    const [, sign, whole, separator, fraction] = single
    const isThousands =
      separator !== undefined && fraction!.length === 3 && whole!.length <= 3 && whole !== "0"
    const digits = separator === undefined ? whole! : isThousands ? whole! + fraction! : `${whole}.${fraction}`
    return Number(`${sign}${digits}`)
  }

  const grouped = text.match(/^(-?)(\d{1,3})((?:([ ., ])\d{3})(?:\4\d{3})*)(?:([.,])(\d+))?$/)
  if (grouped) {
    const [, sign, head, groups, groupSeparator, decimalSeparator, fraction] = grouped
    if (decimalSeparator !== undefined && decimalSeparator === groupSeparator) return undefined
    const digits = head! + groups!.split(groupSeparator!).join("")
    return Number(`${sign}${digits}${fraction === undefined ? "" : `.${fraction}`}`)
  }

  return undefined
}

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

/** The model output is not a usable draft. The message names fields, never their values. */
export class InvoiceDraftParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvoiceDraftParseError"
  }
}

const MAX_ITEMS = 100

/**
 * Reads the model's invoice draft leniently: a missing, null or unusable optional field is
 * absent rather than failing the draft. Money and quantities are never guessed: an item whose
 * quantity or price is present but unreadable or out of range is dropped.
 */
export function parseInvoiceDraftFromModelOutput(output: string): GeneratedInvoiceDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonObjectFromText(output))
  } catch {
    throw new InvoiceDraftParseError("the output is not JSON")
  }
  // Some models wrap the draft in one more object, such as `{"invoice": {...}}`.
  if (isRecord(parsed) && !("items" in parsed)) {
    parsed = Object.values(parsed).find((value) => isRecord(value) && "items" in value) ?? parsed
  }
  if (!isRecord(parsed)) throw new InvoiceDraftParseError("the output is not a JSON object")
  if (!Array.isArray(parsed.items)) throw new InvoiceDraftParseError("items is not a list")

  const items = parsed.items.slice(0, MAX_ITEMS).flatMap((item) => {
    const read = readItem(item)
    return read ? [read] : []
  })
  if (parsed.items.length > 0 && items.length === 0) {
    throw new InvoiceDraftParseError("none of the items has a usable quantity, price or text")
  }

  const taxRate = readModelNumber(parsed.taxRate)
  const dueDate = readText(parsed.dueDate, 10)
  const draft: GeneratedInvoiceDraft = {
    contactId: readText(parsed.contactId, 100),
    contactName: readText(parsed.contactName, 200),
    dueDate: dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : undefined,
    taxRate: taxRate !== undefined && taxRate >= 0 && taxRate <= 100 ? taxRate : undefined,
    notes: readText(parsed.notes, 5000),
    reason: items.length === 0 ? readText(parsed.reason, 500) : undefined,
    items,
  }
  return withoutUndefined(draft)
}

function readItem(value: unknown): GeneratedInvoiceDraft["items"][number] | undefined {
  if (!isRecord(value)) return undefined
  const description = readText(value.description, 500) ?? readText(value.name, 500)
  const catalogItemId = readText(value.catalogItemId, 100)

  // A line the model gave no quantity for is one of it.
  const rawQuantity = value.quantity ?? null
  const quantity = rawQuantity === null ? 1 : readModelNumber(rawQuantity)
  if (quantity === undefined || quantity <= 0 || quantity > 1_000_000) return undefined

  const rawPrice = value.unitPrice ?? value.price ?? null
  const unitPrice = rawPrice === null ? undefined : readModelNumber(rawPrice)
  if (rawPrice !== null && (unitPrice === undefined || unitPrice < 0 || unitPrice > 1_000_000_000)) {
    return undefined
  }

  if (description === undefined && catalogItemId === undefined && unitPrice === undefined) {
    return undefined
  }
  return withoutUndefined({ description, quantity, unitPrice, catalogItemId })
}

function readText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined
  const text = value.trim().slice(0, maxLength)
  return text || undefined
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Asks the organisation's AI provider to draft an invoice from a natural-language prompt.
 * Throws `AiProviderError` (`invalid_response`) when the model output is not a usable draft. A
 * draft with no items, when the prompt describes nothing that was sold, is returned with a reason.
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
    "Respond with one JSON object only, no prose and no markdown, with keys: contactId, contactName, dueDate (YYYY-MM-DD), taxRate, notes, reason, items[]. Use null for a key you have no value for.",
    "Each item has quantity, and may have catalogItemId, description and unitPrice. Write quantity, unitPrice and taxRate as plain JSON numbers without thousands separators or currency: \"5.000 kroner\" is 5000.",
    "The user may write in any language and may include text unrelated to the invoice; ignore that text and draft from what was sold, even when it is described loosely. When the user names a price per item and a count, use the count as quantity and the price as unitPrice.",
    "If the text describes nothing that was sold, return an empty items list and set reason to one short sentence, in the user's language, saying what is missing. Otherwise reason is null.",
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
    responseFormat: INVOICE_DRAFT_RESPONSE_FORMAT,
  })

  try {
    return parseInvoiceDraftFromModelOutput(output)
  } catch (cause) {
    const detail = cause instanceof InvoiceDraftParseError ? cause.message : "unknown reason"
    throw new AiProviderError({
      code: "invalid_response",
      providerId: input.provider.id,
      message: `The AI model returned an invoice draft that could not be parsed: ${detail}`,
      cause,
    })
  }
}
