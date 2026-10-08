import { describe, expect, it } from "vitest"
import { invoicesCsv } from "../accounting-csv"

describe("accounting CSV calendar dates", () => {
  it.each(["America/New_York", "Pacific/Pago_Pago", "Europe/Copenhagen"])(
    "keeps the due day and localizes the issue instant in %s", timezone => {
      const csv = invoicesCsv([{
        number: "INV-1", issueDate: new Date("2026-11-07T00:00:00Z"),
        dueDate: new Date("2028-02-29T00:00:00Z"), customer: "Buyer", currency: "USD",
        net: 100, tax: 0, gross: 100, paid: 0, credited: 0, balance: 100, status: "sent",
      }], timezone)
      expect(csv).toContain("2028-02-29")
      expect(csv).not.toContain("2028-02-28")
      expect(csv).toContain(timezone === "Europe/Copenhagen" ? "2026-11-07" : "2026-11-06")
    }
  )
})
