import { describe, expect, it } from "vitest"
import { storedDocumentTaxRate } from "../stored-tax-rate"

describe("edit form tax rate", () => {
  it.each([
    [[{ taxRate: 25 }], "25"],
    [[{ taxRate: 7.5 }, { taxRate: 25 }], "7.5"],
    [[{ taxRate: 0 }, { taxRate: 12 }], "12"],
    [[{ taxRate: 0 }], "0"],
    [[{ taxRate: "20" }], "20"],
    [[{}], "0"],
    [[], "0"],
  ])("shows the stored rate for %j", (items, expected) => {
    expect(storedDocumentTaxRate(items)).toBe(expected)
  })
})
