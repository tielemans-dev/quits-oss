import { describe, expect, it } from "vitest"
import { calendarDateInputSchema, invoiceCreateDraftV2InputSchema, invoiceUpdateDraftV2InputSchema, invoiceSendInputSchema, invoiceCreateFromDeliverablesInputSchema } from "./invoices"
import { quoteCreateDraftInputSchema, quoteUpdateDraftInputSchema } from "./quotes"
import { recurringCreateInputSchema, recurringUpdateInputSchema } from "./recurring"
import { agreementCreateDraftInputSchema, deliverableUpdateInputSchema } from "./agreements"

const items = [{ description: "Work", quantity: "1", unitPrice: "100" }]
const datetimes = ["2026-11-07T00:30+01:00", "2026-11-07T23:30:00-11:00", "2026-11-07T12:45:00Z"]

describe("calendar-date input compatibility", () => {
  it.each(datetimes)("preserves the written calendar day of %s across calendar inputs", value => {
    expect(calendarDateInputSchema.parse(value)).toBe("2026-11-07")
    expect(invoiceCreateDraftV2InputSchema.parse({ contactId: "buyer", dueDate: value, supplyDate: value, items }))
      .toMatchObject({ dueDate: "2026-11-07", supplyDate: "2026-11-07" })
    expect(invoiceUpdateDraftV2InputSchema.parse({ id: "invoice", dueDate: value, supplyDate: value }))
      .toMatchObject({ dueDate: "2026-11-07", supplyDate: "2026-11-07" })
    expect(invoiceSendInputSchema.parse({ id: "invoice", supplyDate: value, rateDate: value }))
      .toMatchObject({ supplyDate: "2026-11-07", rateDate: "2026-11-07" })
    expect(quoteCreateDraftInputSchema.parse({ contactId: "buyer", expiryDate: value, items })).toMatchObject({ expiryDate: "2026-11-07" })
    expect(quoteUpdateDraftInputSchema.parse({ id: "quote", expiryDate: value })).toMatchObject({ expiryDate: "2026-11-07" })
    expect(recurringCreateInputSchema.parse({ name: "Monthly", contactId: "buyer", items, startDate: value, end: { type: "on_date", endsAt: value } }))
      .toMatchObject({ startDate: "2026-11-07", end: { endsAt: "2026-11-07" } })
    expect(recurringUpdateInputSchema.parse({ id: "schedule", startDate: value })).toMatchObject({ startDate: "2026-11-07" })
    expect(agreementCreateDraftInputSchema.parse({ contactId: "buyer", title: "Work", validUntil: value })).toMatchObject({ validUntil: "2026-11-07" })
    expect(deliverableUpdateInputSchema.parse({ id: "line", agreementId: "agreement", agreedDate: value, expectedDate: value }))
      .toMatchObject({ agreedDate: "2026-11-07", expectedDate: "2026-11-07" })
  })

  it("validates the calendar day, including leap days, without discarding validation of the time", () => {
    expect(calendarDateInputSchema.parse("2028-02-29T23:59:00-11:00")).toBe("2028-02-29")
    expect(calendarDateInputSchema.parse("2028-02-29")).toBe("2028-02-29")
    for (const value of ["2026-02-29", "2026-02-30T12:00Z", "2026-11-07T99:99Z", "2026-11-07garbage", "tomorrow"])
      expect(calendarDateInputSchema.safeParse(value).success, value).toBe(false)
  })

  it("keeps the explicitly supplied deliverable issue instant intact", () => {
    const input = invoiceCreateFromDeliverablesInputSchema.parse({
      agreementId: "agreement", deliverableIds: ["line"], issueDate: datetimes[0], dueDate: datetimes[1],
    })
    expect(input.issueDate).toBe(datetimes[0])
    expect(input.dueDate).toBe("2026-11-07")
  })
})
