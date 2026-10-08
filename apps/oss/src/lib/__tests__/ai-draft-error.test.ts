import { describe, expect, it } from "vitest"
import { aiDraftErrorMessageKey } from "../ai-draft-error"
import { translate } from "../i18n/translate"

describe("aiDraftErrorMessageKey", () => {
  it.each([
    ["UNPROCESSABLE_CONTENT", "invoices.new.ai.error.notAnInvoice"],
    ["TOO_MANY_REQUESTS", "invoices.new.ai.error.busy"],
    ["GATEWAY_TIMEOUT", "invoices.new.ai.error.timeout"],
    ["BAD_GATEWAY", "invoices.new.ai.error.providerFailed"],
  ])("translates %s", (code, key) => {
    expect(aiDraftErrorMessageKey({ data: { code } })).toBe(key)
  })

  it("leaves setup errors and unknown failures to the server message", () => {
    expect(aiDraftErrorMessageKey({ data: { code: "PRECONDITION_FAILED" } })).toBeUndefined()
    expect(aiDraftErrorMessageKey(new Error("offline"))).toBeUndefined()
    expect(aiDraftErrorMessageKey(null)).toBeUndefined()
  })

  it("has Danish copy that says the AI could not make an invoice", () => {
    expect(translate("invoices.new.ai.error.notAnInvoice", "da")).toContain("kunne ikke lave en faktura")
  })
})
