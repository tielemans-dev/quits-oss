import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const send = vi.fn()

vi.mock("resend", () => ({
  Resend: class {
    emails = { send }
  },
}))

describe("email sending", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
  })

  afterEach(() => {
    send.mockReset()
    vi.unstubAllEnvs()
  })

  it("rejects when Resend returns an API error instead of throwing", async () => {
    send.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "Domain is not verified" },
      headers: null,
    })
    const { sendInvitationEmail } = await import("../email")

    await expect(
      sendInvitationEmail({
        to: "person@example.com",
        inviterName: "Ada",
        orgName: "Acme",
        invitationUrl: "https://app.example/accept-invitation/1",
      })
    ).rejects.toThrow("Domain is not verified")
  })

  it("returns the provider message id on success", async () => {
    send.mockResolvedValue({ data: { id: "email_123" }, error: null, headers: null })
    const { sendInvitationEmail } = await import("../email")

    await expect(
      sendInvitationEmail({
        to: "person@example.com",
        inviterName: "Ada",
        orgName: "Acme",
        invitationUrl: "https://app.example/accept-invitation/1",
      })
    ).resolves.toEqual({ id: "email_123" })
  })

  it("forwards an idempotency key so retried sends are deduplicated by the provider", async () => {
    send.mockResolvedValue({ data: { id: "email_123" }, error: null, headers: null })
    const { deliver } = await import("../email")

    await deliver(
      { from: "a@example.com", to: "b@example.com", subject: "Hi", html: "<p>Hi</p>" },
      { idempotencyKey: "yaip-reminder-1" }
    )
    expect(send).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: "yaip-reminder-1" })
  })
})
