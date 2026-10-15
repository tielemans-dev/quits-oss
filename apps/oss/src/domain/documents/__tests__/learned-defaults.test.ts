import { describe, expect, it } from "vitest"
import { learnPaymentTerms, paymentTermsDays, type PastInvoiceTerms } from "../learned-defaults"

const invoice = (issued: string, due: string, timezone = "Europe/Copenhagen"): PastInvoiceTerms =>
  ({ issueDate: new Date(issued), dueDate: new Date(`${due}T00:00:00Z`), timezone })
const terms = (days: number, issued = "2026-09-01T10:00:00Z") =>
  invoice(issued, new Date(Date.parse(`${issued.slice(0, 10)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10))

describe("paymentTermsDays", () => {
  it("counts calendar days in the invoice's time zone", () => {
    expect(paymentTermsDays(invoice("2026-09-01T10:00:00Z", "2026-09-15"))).toBe(14)
    // 23:30 UTC on the 1st is already the 2nd in Copenhagen.
    expect(paymentTermsDays(invoice("2026-09-01T23:30:00Z", "2026-09-16"))).toBe(14)
  })
})

describe("learnPaymentTerms", () => {
  it("suggests nothing from fewer than two invoices", () => {
    expect(learnPaymentTerms([], 30)).toBeNull()
    expect(learnPaymentTerms([terms(14)], 30)).toBeNull()
  })

  it("suggests terms the last two or three invoices share", () => {
    expect(learnPaymentTerms([terms(14), terms(14)], 30)).toEqual({ days: 14, count: 2 })
    expect(learnPaymentTerms([terms(14), terms(14), terms(14)], 30)).toEqual({ days: 14, count: 3 })
  })

  it("reads only the latest three and lets an older different value fall away", () => {
    expect(learnPaymentTerms([terms(14), terms(14), terms(30)], 8)).toEqual({ days: 14, count: 2 })
    expect(learnPaymentTerms([terms(14), terms(14), terms(14), terms(30)], 8)).toEqual({ days: 14, count: 3 })
  })

  it("resets when a newer invoice has a different value", () => {
    expect(learnPaymentTerms([terms(30), terms(14), terms(14)], 8)).toBeNull()
    expect(learnPaymentTerms([terms(14), terms(30), terms(14)], 8)).toBeNull()
  })

  it("skips terms that are the organization's own default", () => {
    expect(learnPaymentTerms([terms(30), terms(30)], 30)).toBeNull()
    expect(learnPaymentTerms([terms(14), terms(14)], null)).toEqual({ days: 14, count: 2 })
  })

  it("keeps a cleared value cleared until a different one is learned", () => {
    expect(learnPaymentTerms([terms(14), terms(14)], 30, 14)).toBeNull()
    expect(learnPaymentTerms([terms(8), terms(8)], 30, 14)).toEqual({ days: 8, count: 2 })
  })

  it("ignores due dates before the issue date", () => {
    expect(learnPaymentTerms([terms(-3), terms(-3)], 30)).toBeNull()
  })
})
