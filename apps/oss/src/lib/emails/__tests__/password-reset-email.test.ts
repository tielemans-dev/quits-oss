import { describe, expect, it } from "vitest"
import { buildPasswordResetEmailContent } from "../password-reset-email"

describe("password reset email", () => {
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
