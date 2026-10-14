import { describe, expect, it } from "vitest"
import { orderedDocumentTaxIds } from "../context"
import { vatIdentifier } from "../../../lib/exports/parties"

describe("document tax id order", () => {
  it("resolves the primary VAT identifier ahead of an older or foreign row", () => {
    const foreign = { scheme: "vat", value: "DE123456789", countryCode: "DE", isPrimary: false, createdAt: new Date("2020-01-01") }
    const obsolete = { scheme: "vat", value: "DK24256790", countryCode: "DK", isPrimary: false, createdAt: new Date("2020-01-02") }
    const primary = { scheme: "cvr", value: "87654321", countryCode: "DK", isPrimary: true, createdAt: new Date("2020-01-03") }
    for (const rows of [[foreign, obsolete, primary], [obsolete, primary, foreign], [primary, foreign, obsolete]]) {
      const ordered = orderedDocumentTaxIds(rows)
      expect(ordered.map(id => id.value)).toEqual(["87654321", "DE123456789", "DK24256790"])
      const stored = ordered.map(({ scheme, value, countryCode }) => ({ scheme, value, countryCode }))
      expect(vatIdentifier(stored, "DK")).toBe("DK87654321")
      expect(vatIdentifier(rows, "DK")).toBe("DK87654321")
    }
  })
})
