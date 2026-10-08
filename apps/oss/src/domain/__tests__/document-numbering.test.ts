import { describe, expect, it } from "vitest"
import { InvalidState } from "../errors"
import {
  DOCUMENT_NOT_ISSUED, asIssued, documentRef, isDocumentNotIssued, issuedNumber, nextNumberFromSettings, numberVoidedByDraftDeletion,
} from "../documents/numbering"

const settings = {
  agreementPrefix: "AGR", agreementNextNum: 3, invoicePrefix: "FAK", invoiceNextNum: 42,
  quotePrefix: "TIL", quoteNextNum: 7, creditNotePrefix: "KN", creditNoteNextNum: 12,
}

describe("document numbers", () => {
  it("reads the next number of each kind from the settings, and the defaults when there are none", () => {
    expect(nextNumberFromSettings("invoice", settings)).toBe("FAK-0042")
    expect(nextNumberFromSettings("quote", settings)).toBe("TIL-0007")
    expect(nextNumberFromSettings("creditNote", settings)).toBe("KN-0012")
    expect(nextNumberFromSettings("agreement", settings)).toBe("AGR-0003")
    expect(nextNumberFromSettings("invoice", null)).toBe("INV-0001")
    expect(nextNumberFromSettings("quote", null)).toBe("QTE-0001")
    expect(nextNumberFromSettings("creditNote", null)).toBe("CN-0001")
    expect(nextNumberFromSettings("agreement", null)).toBe("AGR-0001")
  })

  it("names a document without printing null", () => {
    expect(documentRef("invoice", "INV-0042")).toBe("invoice INV-0042")
    expect(documentRef("quote", null)).toBe("draft quote")
  })

  it("raises a typed refusal for an issued document without a number", () => {
    expect(issuedNumber({ number: "INV-1" })).toBe("INV-1")
    expect(asIssued({ id: "a", number: "INV-1" })).toEqual({ id: "a", number: "INV-1" })
    let caught: unknown
    try { issuedNumber({ number: null }) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(InvalidState)
    expect(caught).toMatchObject({ code: DOCUMENT_NOT_ISSUED })
    expect(isDocumentNotIssued(caught)).toBe(true)
    expect(isDocumentNotIssued(new Error("other"))).toBe(false)
  })

  it("describes the gap a deleted draft leaves, only when it held a number", () => {
    expect(numberVoidedByDraftDeletion("invoice", "inv_1", null, "org_1")).toEqual([])
    expect(numberVoidedByDraftDeletion("quote", "quo_1", "QTE-0004", "org_1")).toEqual([{
      aggregateType: "document", aggregateId: "quo_1", type: "document.number_voided",
      payload: { organizationId: "org_1", documentKind: "quote", number: "QTE-0004", reason: "draft_deleted" },
    }])
  })
})
