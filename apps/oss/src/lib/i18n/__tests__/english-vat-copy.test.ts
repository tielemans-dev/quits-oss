import { describe, expect, it } from "vitest"
import { enMessages } from "../messages"

/** English copy says VAT. "momsloven" stays only where a statute is cited by its Danish name. */
const CITATION = /\(momsloven\)/g

describe("English VAT copy (QUI-286)", () => {
  it("never uses the Danish word moms", () => {
    for (const [key, value] of Object.entries(enMessages)) {
      expect(String(value).replace(CITATION, ""), key).not.toMatch(/moms/i)
    }
  })
})
