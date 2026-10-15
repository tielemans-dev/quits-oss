import { describe, expect, it } from "vitest"
import { followLineIssue, type IssueLine } from "../line-issues"
import type { ReadableIssue } from "../readable-errors"

const row = (rowKey: string, unitPrice = "0"): IssueLine => ({ rowKey, description: rowKey, quantity: "1", unitPrice })
const [a, b, c] = [row("a", "1"), row("b", "x"), row("c", "3")]
const issue = { field: "items", line: 1, column: "unitPrice", key: "validation.line.price.invalid" } as ReadableIssue
const follow = (now: IssueLine[]) => followLineIssue(issue, [a, b, c], now)?.line ?? null

describe("followLineIssue", () => {
  it("follows the row when rows are deleted, inserted or reordered around it", () => {
    expect(follow([b, c])).toBe(0)
    expect(follow([row("new"), a, b, c])).toBe(2)
    expect(follow([c, b, a])).toBe(1)
    expect(follow([b, a, c])).toBe(0)
    expect(follow([a, { ...b, quantity: "9" }, c])).toBe(1)
  })

  it("drops the issue when its row is gone or its value was edited, and never moves it to another row", () => {
    expect(follow([a, c])).toBeNull()
    expect(follow([a, row("b", "5"), c])).toBeNull()
    expect(follow([a, row("other", "x"), c])).toBeNull()
  })
})
