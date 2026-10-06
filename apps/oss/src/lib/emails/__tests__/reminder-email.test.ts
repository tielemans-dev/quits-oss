import { describe, expect, it } from "vitest"
import { buildReminderEmailContent } from "../reminder-email"

const base = {
  fromName: "Acme <ApS>",
  fromEmail: "billing@acme.test",
  invoice: { number: "INV-0042", dueDate: "2026-06-01T00:00:00Z", currency: "DKK", balanceDue: 1250 },
  contactName: "Kunde & Co",
  publicPaymentUrl: "https://app.example.com/pay/token",
}

describe("reminder email", () => {
  it("renders a localized overdue reminder with balance due and pay link", () => {
    const content = buildReminderEmailContent({
      ...base,
      stage: "overdue",
      org: { companyName: "Acme", companyEmail: "billing@acme.test", locale: "da-DK", timezone: "Europe/Copenhagen" },
    })

    expect(content.subject).toContain("Forfalden: faktura INV-0042")
    expect(content.html).toContain("Restbeløb")
    expect(content.html).toContain("https://app.example.com/pay/token")
    expect(content.html).toContain("Kunde &amp; Co")
    expect(content.html).not.toContain("Kunde & Co")
  })

  it("renders an English upcoming reminder without a pay link", () => {
    const content = buildReminderEmailContent({
      ...base,
      publicPaymentUrl: null,
      stage: "upcoming",
      org: { companyName: "Acme", locale: "en-US", timezone: "UTC" },
    })

    expect(content.subject).toBe("Reminder: invoice INV-0042 is due June 1, 2026")
    expect(content.html).toContain("Balance due")
    expect(content.html).not.toContain("/pay/")
  })
})
