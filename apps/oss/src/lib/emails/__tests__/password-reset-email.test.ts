import { afterEach, describe, expect, it, vi } from "vitest"
import { buildPasswordResetEmailContent, sendPasswordResetEmail } from "../password-reset-email"

const send = vi.hoisted(() => vi.fn().mockResolvedValue({ data: { id: "reset-message" }, error: null }))
vi.mock("resend", () => ({ Resend: class { emails = { send } } }))
afterEach(() => { send.mockClear(); vi.unstubAllEnvs() })

describe("password reset email", () => {
  it.each([undefined, "explicit@example.com"])("renders with the delivery environment sender and respects explicit input %s", async (fromEmail) => {
    vi.stubEnv("FROM_EMAIL", "global@example.com")
    await sendPasswordResetEmail({
      to: "recipient@example.com", name: "Recovery", resetUrl: "https://app.example/reset", fromEmail,
    }, { environment: { FROM_EMAIL: "installation@example.com", RESEND_API_KEY: "test-only-key" } })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: `Quits <${fromEmail ?? "installation@example.com"}>` }), undefined)
  })

  it("escapes recipient names and URL attributes, and uses the installation sender", () => {
    const content = buildPasswordResetEmailContent({
      name: '<img src=x onerror="alert(1)">',
      resetUrl: 'https://app.example/api/auth/reset-password/test?callbackURL=https%3A%2F%2Fapp.example%2Freset-password&other="value"',
      fromEmail: "recovery@example.com\r\n",
    })
    expect(content.html).not.toContain("<img")
    expect(content.html).toContain("&lt;img")
    expect(content.html).toContain("&amp;other=&quot;value&quot;")
    expect(content.html).toContain("30 minutes")
    expect(content.fromAddress).toBe("Quits <recovery@example.com>")
    expect(content.subject).toBe("Reset your Quits password")
  })

  it("renders Danish content and refuses unsafe URL schemes", () => {
    const input = { name: "Anna", resetUrl: "https://app.example/reset", locale: "da-DK" }
    expect(buildPasswordResetEmailContent(input).html).toContain("Linket udløber om 30 minutter")
    expect(buildPasswordResetEmailContent(input).subject).toBe("Nulstil din Quits-adgangskode")
    expect(() => buildPasswordResetEmailContent({ ...input, resetUrl: "javascript:alert(1)" })).toThrow("Invalid password reset URL")
  })
})
