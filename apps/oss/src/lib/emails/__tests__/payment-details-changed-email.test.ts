import { afterEach, describe, expect, it, vi } from "vitest"
import {
  buildPaymentDetailsChangedEmailContent,
  sendPaymentDetailsChangedEmail,
} from "../payment-details-changed-email"

const send = vi.hoisted(() => vi.fn().mockResolvedValue({ data: { id: "message-1" }, error: null }))
vi.mock("resend", () => ({ Resend: class { emails = { send } } }))
afterEach(() => { send.mockClear(); vi.unstubAllEnvs() })

const input = {
  changedBy: "Mette Admin",
  changedAt: "2026-10-08T09:30:00.000Z",
  organizationName: "Nordic Design ApS",
  changes: [
    { field: "iban" as const, before: "****6243", after: "****1100" },
    { field: "bankName" as const, before: "Danske Bank", after: null },
  ],
}

describe("payment details changed email", () => {
  it("says who changed the details, when, and what changed, with masked values", () => {
    const content = buildPaymentDetailsChangedEmailContent({ ...input, locale: "en-US", timezone: "Europe/Copenhagen" })

    expect(content.subject).toBe("The bank details on your invoices were changed")
    expect(content.html).toContain("The bank details on your invoices were changed by Mette Admin.")
    expect(content.html).toContain("Nordic Design ApS")
    expect(content.html).toContain("October 8, 2026 at 11:30")
    expect(content.html).toContain("****6243")
    expect(content.html).toContain("****1100")
    expect(content.html).toContain("Danske Bank")
    expect(content.html).toContain("(none)")
    expect(content.html).toContain("If this wasn&#39;t you, change your password and check your settings.")
  })

  it("lists the changes in field order whatever order they arrive in", () => {
    const html = buildPaymentDetailsChangedEmailContent(input).html
    expect(html.indexOf("Bank</td>")).toBeGreaterThan(-1)
    expect(html.indexOf("Bank</td>")).toBeLessThan(html.indexOf("IBAN</td>"))
  })

  it("is written in the organization's language and time zone", () => {
    const content = buildPaymentDetailsChangedEmailContent({ ...input, locale: "da-DK", timezone: "Europe/Copenhagen" })
    expect(content.subject).toBe("Bankoplysningerne på dine fakturaer er ændret")
    expect(content.html).toContain("Bankoplysningerne på dine fakturaer blev ændret af Mette Admin.")
    expect(content.html).toContain("8. oktober 2026")
    expect(content.html).toContain("kl. 11.30")
    expect(content.html).toContain("(ingen)")
    expect(content.html).toContain("Hvis det ikke var dig, skal du skifte din adgangskode og tjekke dine indstillinger.")
  })

  it("escapes names", () => {
    const content = buildPaymentDetailsChangedEmailContent({
      ...input,
      changedBy: '<img src=x onerror="alert(1)">',
      organizationName: "<b>Acme</b>",
    })
    expect(content.html).not.toContain("<img")
    expect(content.html).not.toContain("<b>Acme")
    expect(content.html).toContain("&lt;img")
  })

  it("uses the installation sender and sends through the configured provider", async () => {
    await sendPaymentDetailsChangedEmail(
      { ...input, to: "admin@example.com" },
      { environment: { FROM_EMAIL: "installation@example.com", RESEND_API_KEY: "test-only-key" }, idempotencyKey: "key-1" }
    )
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Quits <installation@example.com>",
        to: "admin@example.com",
        subject: "The bank details on your invoices were changed",
      }),
      { idempotencyKey: "key-1" }
    )
  })
})
