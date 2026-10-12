import { describe, expect, it } from "vitest"
import { invoiceDisplayStatus } from "../payments/invoice-display-status"

const now = new Date("2026-10-12T10:00:00Z")
const invoice = { status: "sent", paymentStatus: "unpaid", dueDate: "2026-10-11T00:00:00Z" }

describe("invoiceDisplayStatus", () => {
  it.each(["sent", "viewed"])("shows a past-due %s invoice as overdue before the scheduler runs", status => {
    expect(invoiceDisplayStatus({ ...invoice, status }, "Europe/Copenhagen", now)).toBe("overdue")
  })

  it.each(["draft", "paid", "cancelled", "credited"])("preserves %s over a past due date", status => {
    expect(invoiceDisplayStatus({ ...invoice, status }, "Europe/Copenhagen", now)).toBe(status)
  })

  it.each(["sent", "viewed", "overdue"])("shows fully paid %s invoices as paid", status => {
    expect(invoiceDisplayStatus({ ...invoice, status, paymentStatus: "paid" }, "Europe/Copenhagen", now)).toBe("paid")
  })

  it("keeps overdue precedence over partial payment", () => {
    expect(invoiceDisplayStatus({ ...invoice, paymentStatus: "partially_paid" }, "Europe/Copenhagen", now)).toBe("overdue")
    expect(invoiceDisplayStatus({ ...invoice, dueDate: "2026-10-12", paymentStatus: "partially_paid" }, "Europe/Copenhagen", now)).toBe("partially_paid")
  })

  it.each([
    ["Europe/Copenhagen", "2026-10-11", "2026-10-11T21:59:59.999Z", "sent"],
    ["Europe/Copenhagen", "2026-10-11", "2026-10-11T22:00:00Z", "overdue"],
    ["America/New_York", "2026-10-11", "2026-10-12T03:59:59.999Z", "sent"],
    ["America/New_York", "2026-10-11", "2026-10-12T04:00:00Z", "overdue"],
    ["Europe/Copenhagen", "2026-10-25", "2026-10-25T22:59:59.999Z", "sent"],
    ["Europe/Copenhagen", "2026-10-25", "2026-10-25T23:00:00Z", "overdue"],
  ])("honors the due-day boundary in %s at %s / %s", (timezone, dueDate, instant, status) => {
    expect(invoiceDisplayStatus({ ...invoice, dueDate }, timezone, new Date(instant))).toBe(status)
  })

  it("preserves viewed status on a future due day", () => {
    expect(invoiceDisplayStatus({ ...invoice, status: "viewed", dueDate: "2026-10-13" }, "UTC", now)).toBe("viewed")
  })

  it("uses UTC for missing or invalid timezones", () => {
    const instant = new Date("2026-10-11T23:00:00Z")
    for (const timezone of [undefined, null, "invalid/zone"]) {
      expect(invoiceDisplayStatus(invoice, timezone, instant)).toBe("sent")
    }
  })

  it("preserves existing status when the due date is missing or invalid", () => {
    for (const dueDate of [undefined, "invalid"]) {
      expect(invoiceDisplayStatus({ ...invoice, dueDate }, "UTC", now)).toBe("sent")
    }
    expect(invoiceDisplayStatus({ status: "overdue", paymentStatus: "partially_paid" }, "UTC", now)).toBe("overdue")
  })
})
