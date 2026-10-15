import { describe, expect, it } from "vitest"
import { isEmailSendFailure, isUnexpectedFailure } from "../email-send-failure"

const trpcError = (code: string, reason: string | null, message = "raw provider text") => Object.assign(new Error(message), { data: { code, reason } })

describe("email send failures", () => {
  it.each(["email_provider_refused", "email_provider_unreachable", "email_unavailable", "email_not_sent"])("recognises %s", reason => {
    expect(isEmailSendFailure(trpcError("PRECONDITION_FAILED", reason))).toBe(true)
  })

  it.each([null, "not_draft", "changed_since_review"])("does not mistake the refusal %s for an email failure", reason => {
    expect(isEmailSendFailure(trpcError("BAD_REQUEST", reason))).toBe(false)
  })

  it("does not mistake an error without server data for one", () => {
    expect(isEmailSendFailure(new Error("Failed to fetch"))).toBe(false)
    expect(isEmailSendFailure(null)).toBe(false)
  })

  it("treats a server error without a domain reason as unexpected, and an app refusal as not", () => {
    expect(isUnexpectedFailure(trpcError("INTERNAL_SERVER_ERROR", null))).toBe(true)
    expect(isUnexpectedFailure(trpcError("INTERNAL_SERVER_ERROR", "email_provider_refused"))).toBe(false)
    expect(isUnexpectedFailure(trpcError("BAD_REQUEST", "not_draft"))).toBe(false)
    expect(isUnexpectedFailure(new Error("Exemption requires reason text"))).toBe(false)
  })
})
