import type { ReadableIssue } from "./readable-errors"

export type IssueLine = { rowKey: string; description: string; quantity: string; unitPrice: string; vat?: unknown }

const columns = ["description", "quantity", "unitPrice", "vat"] as const

/** Follow an issue to where its submitted row is now, matching rows by identity rather than position. Null once the row is gone or the reported value was edited. */
export function followLineIssue(issue: ReadableIssue, submitted: IssueLine[], now: IssueLine[]): ReadableIssue | null {
  if (issue.line === undefined) return now.length === submitted.length ? issue : null
  const before = submitted[issue.line]
  const line = now.findIndex((row) => row.rowKey === before?.rowKey)
  if (!before || line < 0) return null
  return (issue.column ? [issue.column] : columns).every((column) => now[line][column] === before[column]) ? { ...issue, line } : null
}
