import { describe, expect, it, vi } from "vitest"
import { computeSettlement } from "../../domain/documents/settlement"
import { invoiceDisplayStatus } from "../payments/invoice-display-status"

const now = new Date("2026-10-12T10:00:00Z")
const invoice = { balanceDue: 100, status: "sent", paymentStatus: "unpaid", dueDate: "2026-10-11T00:00:00Z" }

describe("invoiceDisplayStatus", () => {
  it("uses the list's shared calendar day without constructing a formatter per row", () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat")
    try {
      for (let row = 0; row < 100; row++) {
        expect(invoiceDisplayStatus(invoice, "Europe/Copenhagen", "2026-10-12")).toBe("overdue")
      }
      expect(invoiceDisplayStatus(invoice, "Europe/Copenhagen", "2026-10-11")).toBe("sent")
      expect(formatter).not.toHaveBeenCalled()
    } finally { formatter.mockRestore() }
  })

  it.each(["sent", "viewed"])("shows a past-due %s invoice as overdue before the scheduler runs", status => {
    expect(invoiceDisplayStatus({ ...invoice, status }, "Europe/Copenhagen", now)).toBe("overdue")
  })

  it.each([
    [0, 0, 0, "sent"],
    [100, 0, 0, "overdue"],
    ["0.01", 0, 0, "overdue"],
    [100, 40, 0, "overdue"],
    [100, 100, 0, "paid"],
    [100, 120, 0, "paid"],
    [-100, 0, 0, "sent"],
    [100, 0, 100, "sent"],
    [100, 0, 120, "sent"],
    [100, 0, "99.99", "overdue"],
    [100, 70, 30, "paid"],
  ])("uses the settlement balance for total=%s, paid=%s, credited=%s", (totalGross, amountPaid, amountCredited, expected) => {
    const settlement = computeSettlement({ totalGross, amountPaid, amountCredited })
    expect(invoiceDisplayStatus({
      ...invoice,
      paymentStatus: settlement.paymentStatus,
      balanceDue: settlement.balanceDue.toNumber(),
    }, "Europe/Copenhagen", now)).toBe(expected)
  })

  it.each([0, -0.01])("does not derive overdue for a nonpositive balance of %s", balanceDue => {
    expect(invoiceDisplayStatus({ ...invoice, balanceDue }, "Europe/Copenhagen", now)).toBe("sent")
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
    expect(invoiceDisplayStatus({ status: "overdue", paymentStatus: "partially_paid", balanceDue: 100 }, "UTC", now)).toBe("overdue")
  })

  describe("reminder sent", () => {
    const tz = "Europe/Copenhagen"

    it("derives reminder_sent for an overdue invoice whose reminder succeeded", () => {
      expect(invoiceDisplayStatus(invoice, tz, now, true)).toBe("reminder_sent")
      expect(invoiceDisplayStatus({ ...invoice, status: "overdue" }, tz, now, true)).toBe("reminder_sent")
    })

    it("leaves invoices without a succeeded reminder step alone", () => {
      expect(invoiceDisplayStatus(invoice, tz, now, false)).toBe("overdue")
      expect(invoiceDisplayStatus(invoice, tz, now)).toBe("overdue")
    })

    it.each([
      ["paid", { paymentStatus: "paid" }],
      ["credited", { status: "credited" }],
      ["sent", { balanceDue: 0 }],
    ])("shows %s, not reminder_sent, once the invoice is not overdue", (expected, change) => {
      expect(invoiceDisplayStatus({ ...invoice, ...change }, tz, now, true)).toBe(expected)
    })
  })
})
