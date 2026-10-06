import { ValidationFailed } from "../errors"

/**
 * Keyset pagination for agent list tools. The cursor encodes the sort key and id of the last
 * row, so pages stay stable while new rows are added.
 */
export type PageCursor = { key: string; id: string }

export function encodeCursor(cursor: PageCursor) {
  return Buffer.from(JSON.stringify([cursor.key, cursor.id]), "utf8").toString("base64url")
}

export function decodeCursor(value: string | undefined): PageCursor | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { key: parsed[0], id: parsed[1] }
    }
  } catch {
    // Fall through to the error below.
  }
  throw new ValidationFailed({ message: "Invalid cursor; pass nextCursor from the previous page" })
}

/** Rows were fetched with `take: limit + 1`; returns the page and the cursor for the next one. */
export function toPage<Row extends { id: string }>(
  rows: Row[],
  limit: number,
  sortKey: (row: Row) => string
) {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor({ key: sortKey(last), id: last.id }) : null,
  }
}

/** `where` clause continuing a newest-first list after the cursor row. */
export function afterNewest(cursor: PageCursor | null) {
  if (!cursor) {
    return {}
  }
  const createdAt = new Date(cursor.key)
  return {
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }],
  }
}
