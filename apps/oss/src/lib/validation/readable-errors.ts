import type { TranslationKey } from "../i18n/catalog"

export type ReadableField = "contact" | "dueDate" | "items" | "notes" | "email" | "cvr" | "form"
export type ReadableIssue = {
  field: ReadableField
  /** Zero-based line index for `items` issues that belong to one line. */
  line?: number
  /** The line column the issue belongs to, when it is not the line as a whole. */
  column?: "description" | "quantity" | "unitPrice" | "vat"
  key: TranslationKey
  params?: { max: number }
}

type RawIssue = { path?: unknown; code?: unknown; message?: unknown; maximum?: unknown; format?: unknown; origin?: unknown }

/** Server-side custom issue messages that already are validation keys. */
const KEYED_MESSAGES: Record<string, { field: ReadableField; key: TranslationKey }> = {
  "cvr.invalid": { field: "cvr", key: "validation.cvr.invalid" },
  "dueDate.beforeIssue": { field: "dueDate", key: "validation.dueDate.beforeIssue" },
  "email.invalid": { field: "email", key: "validation.email.invalid" },
}

const UNKNOWN: ReadableIssue = { field: "form", key: "validation.unknown" }

function looksStructured(message: string) {
  const start = message.trimStart()[0]
  return start === "[" || start === "{"
}

function rawIssues(message: string): RawIssue[] | null {
  try {
    const parsed: unknown = JSON.parse(message)
    const list = Array.isArray(parsed) ? parsed : (parsed as { issues?: unknown } | null)?.issues
    if (!Array.isArray(list)) return null
    // Entries come from the wire: skip anything that is not an object so mapping cannot throw.
    return list.filter((entry): entry is RawIssue => typeof entry === "object" && entry !== null && !Array.isArray(entry))
  } catch {
    return null
  }
}

function mapIssue(issue: RawIssue): ReadableIssue {
  const message = typeof issue.message === "string" ? issue.message : ""
  const keyed = KEYED_MESSAGES[message]
  if (keyed) return keyed
  const path = Array.isArray(issue.path) ? issue.path : []
  const [head, index, leaf] = path
  const tooLong = issue.code === "too_big" && issue.origin === "string" && typeof issue.maximum === "number"
  const field: ReadableField = head === "contactId" ? "contact" : head === "dueDate" ? "dueDate" : head === "items" ? "items" : head === "notes" ? "notes" : "form"
  const line = typeof index === "number" ? index : undefined
  const column = leaf === "description" || leaf === "quantity" || leaf === "unitPrice" || leaf === "vat" ? leaf : undefined
  const at = { field, ...(line === undefined ? {} : { line }), ...(column ? { column } : {}) }
  if (tooLong) return { ...at, key: "validation.tooLong", params: { max: issue.maximum as number } }
  if (issue.format === "email") return { field: "email", key: "validation.email.invalid" }
  if (field === "contact") return { ...at, key: "validation.customer.required" }
  if (field === "dueDate") return { ...at, key: "validation.date.invalid" }
  if (field === "items") {
    if (line === undefined) return issue.code === "too_small" ? { ...at, key: "validation.lines.empty" } : { ...at, key: "validation.unknown" }
    if (column === "description") return { ...at, key: "validation.line.description.required" }
    if (column === "quantity") return { ...at, key: "validation.line.qty.invalid" }
    if (column === "unitPrice") return { ...at, key: "validation.line.price.invalid" }
  }
  return { ...at, field: field === "items" ? "items" : "form", key: "validation.unknown" }
}

/**
 * Turns a failed save into readable issues when the server reported structured validation errors
 * (a JSON array of issues in the error message). Returns `null` for plain-text server messages so
 * the caller can keep showing them. Structured payloads never leak: unmapped ones become the
 * generic "check this field" fallback.
 */
export function readableIssues(error: unknown): ReadableIssue[] | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null
  if (message === null || !looksStructured(message)) return null
  const issues = rawIssues(message)
  if (!issues || issues.length === 0) return [UNKNOWN]
  // One value can fail several checks (format and range); each maps to the same message, so keep one.
  const seen = new Set<string>()
  return issues.map(mapIssue).filter((issue) => {
    const id = [issue.field, issue.line ?? "", issue.column ?? "", issue.key, issue.params?.max ?? ""].join("|")
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}
