import { describe, expect, it } from "vitest"
import { assertDistinctDocumentPrefixes } from "../document-prefixes"

describe("assertDistinctDocumentPrefixes", () => {
  const stored = { invoicePrefix: "INV", creditNotePrefix: "CN" }

  it("refuses a change that makes the prefixes equal, ignoring case and spaces", () => {
    expect(() => assertDistinctDocumentPrefixes(stored, { creditNotePrefix: " inv " }, "da-DK"))
      .toThrow("Fakturaer og kreditnotaer skal have forskellige præfikser")
    expect(() => assertDistinctDocumentPrefixes(stored, { invoicePrefix: "CN" }, "en-US")).toThrow("different prefixes")
  })

  it("keeps saves that leave equal stored prefixes untouched", () => {
    const equal = { invoicePrefix: "DOC", creditNotePrefix: "DOC" }
    expect(() => assertDistinctDocumentPrefixes(equal, {}, "en-US")).not.toThrow()
    expect(() => assertDistinctDocumentPrefixes(equal, { invoicePrefix: "doc", creditNotePrefix: "DOC" }, "en-US")).not.toThrow()
    expect(() => assertDistinctDocumentPrefixes(equal, { creditNotePrefix: "CN" }, "en-US")).not.toThrow()
  })
})
