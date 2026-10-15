import { describe, expect, it } from "vitest"
import { normalizeReminderRecipient, reminderPreferenceId, signReminderUnsubscribeToken, verifyReminderUnsubscribeToken } from "../unsubscribe-token"

const binding = { id: "ca4bc3d8-4371-4af0-9c03-6f2971a3c223", organizationId: "org-one", recipient: "buyer@example.test" }
const secret = "test-reminder-secret-with-at-least-32-characters"

describe("automatic reminder unsubscribe tokens", () => {
  it("exposes only the opaque preference ID and binds recipient, organization and action", () => {
    const token = signReminderUnsubscribeToken(binding, secret)
    expect(reminderPreferenceId(token)).toBe(binding.id)
    expect(verifyReminderUnsubscribeToken(token, binding, secret)).toBe(true)
    expect(token).not.toContain(binding.recipient)
    expect(token).not.toContain(binding.organizationId)
    expect(verifyReminderUnsubscribeToken(token, { ...binding, recipient: "other@example.test" }, secret)).toBe(false)
    expect(verifyReminderUnsubscribeToken(token, { ...binding, organizationId: "org-two" }, secret)).toBe(false)
    expect(verifyReminderUnsubscribeToken(token, binding, "different-secret")).toBe(false)
    expect(verifyReminderUnsubscribeToken(token.replace("v1.", "waitlist-unsub."), binding, secret)).toBe(false)
  })

  it.each(["", "v1", "v1.not-a-uuid.signature", "v1." + binding.id + ".", "a".repeat(5000)])("rejects malformed tokens without lookup: %s", token => {
    expect(reminderPreferenceId(token)).toBeNull()
    expect(verifyReminderUnsubscribeToken(token, binding, secret)).toBe(false)
  })

  it("rejects tampering and trailing bytes and normalizes the mailbox consistently", () => {
    const token = signReminderUnsubscribeToken(binding, secret)
    expect(verifyReminderUnsubscribeToken(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a"), binding, secret)).toBe(false)
    expect(verifyReminderUnsubscribeToken(token + "\n", binding, secret)).toBe(false)
    expect(normalizeReminderRecipient("  BUYER@Example.Test  ")).toBe(binding.recipient)
    expect(signReminderUnsubscribeToken({ ...binding, recipient: " BUYER@EXAMPLE.TEST " }, secret)).toBe(token)
  })
})
