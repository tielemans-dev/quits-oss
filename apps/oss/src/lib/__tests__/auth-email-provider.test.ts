import { afterEach, describe, expect, it, vi } from "vitest"
import { buildQuitsAuthOptions } from "../runtime/auth-config"
import { sendInvitationEmail } from "../email"

vi.mock("../email", () => ({ sendInvitationEmail: vi.fn() }))
afterEach(() => vi.mocked(sendInvitationEmail).mockReset())

function invitationHook(configuration: Record<string, string>) {
  return buildQuitsAuthOptions({
    prisma: { orgSettings: { findUnique: vi.fn().mockResolvedValue({ locale: "en-US" }) } } as never,
    env: { getEnv: (name) => configuration[name] },
  }).plugins[0].options.sendInvitationEmail
}

const invitation = { id: "invite-42", email: "person@example.com", inviter: { user: { name: "Ada" } }, organization: { id: "org-42", name: "Acme" } }

describe("auth invitation email provider", () => {
  it("sends invitations with SMTP when there is no Resend key", async () => {
    const send = invitationHook({ BETTER_AUTH_URL: "https://app.example", EMAIL_PROVIDER: "smtp", SMTP_HOST: "relay.example" })
    await send(invitation as never)
    expect(sendInvitationEmail).toHaveBeenCalledWith({ to: "person@example.com", inviterName: "Ada", orgName: "Acme", invitationUrl: "https://app.example/accept-invitation/invite-42", locale: "en-US" })
  })

  it("keeps the previous default behavior without a Resend key", async () => {
    await invitationHook({ BETTER_AUTH_URL: "https://app.example" })(invitation as never)
    expect(sendInvitationEmail).not.toHaveBeenCalled()
  })

  it("rejects invalid SMTP configuration before sending", async () => {
    await expect(invitationHook({ BETTER_AUTH_URL: "https://app.example", EMAIL_PROVIDER: "smtp" })(invitation as never)).rejects.toThrow("SMTP_HOST")
    expect(sendInvitationEmail).not.toHaveBeenCalled()
  })
})
