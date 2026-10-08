import { describe, expect, it } from "vitest"
import type { CollectionAuthority, RecurringInstruction } from "../model"
import { recurringAmendmentImpact } from "../recurring-instructions"

const current: RecurringInstruction = {
  recurringInvoiceId: "support", version: 1, currency: "DKK", periodGrossMinor: "10000",
  intervalUnit: "month", intervalCount: 2, anchorDate: "2026-10-01", effectiveFrom: "2026-10-01",
  dueInDays: 14, end: { type: "none" }, delivery: "draft_only", collection: { kind: "saved_method", authorityId: "authority" },
}
const authority: CollectionAuthority = {
  authorityId: "authority", version: 1, status: "active", scope: { kind: "recurring", recurringInvoiceId: "support", version: 1 },
  currency: "DKK", maxChargeMinor: "10000", minDaysBetweenCharges: 30, consentEvidenceRef: "evidence",
}
const amend = (instruction: RecurringInstruction, change: Partial<RecurringInstruction>, previewCount: number, minimumDays = 30) =>
  recurringAmendmentImpact(instruction, { ...instruction, ...change, version: instruction.version + 1 }, {
    today: instruction.effectiveFrom, generatedRuns: [], previewCount,
  }, { ...authority, minDaysBetweenCharges: minimumDays })

describe("recurring authority covers the whole amended term", () => {
  it.each([0, 1, 3, 12])("finds February outside the first three runs with previewCount %i", (previewCount) => {
    const impact = amend(current, { intervalCount: 1 }, previewCount)
    expect(impact.refusals).toEqual([])
    expect(impact.authority).toEqual({ renewalRequired: true, reasons: ["Charges are closer together than authorized"] })
    expect(impact.consent.required).toBe(true)
    expect(impact.futureRuns).toHaveLength(previewCount)
  })

  it.each([0, 1, 3, 12])("honours finite date and count boundaries with previewCount %i", (previewCount) => {
    for (const end of [{ type: "on_date", endsAt: "2027-02-01" }, { type: "after_runs", runs: 5 }] as const) {
      // October through February contains gaps of 31, 30, 31 and 31 days. March adds 28.
      const before = { ...current, end }
      expect(amend(before, { intervalCount: 1 }, previewCount).authority).toEqual({ renewalRequired: false, reasons: [] })
    }
    for (const end of [{ type: "on_date", endsAt: "2027-03-01" }, { type: "after_runs", runs: 6 }] as const) {
      const before = { ...current, end }
      expect(amend(before, { intervalCount: 1 }, previewCount).authority).toEqual({ renewalRequired: true, reasons: ["Charges are closer together than authorized"] })
    }
  })

  it.each([0, 1, 3, 12])("checks leap-year short months and the following non-leap year with previewCount %i", (previewCount) => {
    const before = { ...current, anchorDate: "2027-10-01", effectiveFrom: "2027-10-01" }
    expect(amend(before, { intervalCount: 1 }, previewCount, 30).authority?.renewalRequired).toBe(true)
    // February 2028 is 29 days. An open term also includes a 28-day February in 2029.
    expect(amend(before, { intervalCount: 1 }, previewCount, 29).authority?.renewalRequired).toBe(true)
    const finite = { ...before, end: { type: "on_date" as const, endsAt: "2028-03-01" } }
    expect(amend(finite, { intervalCount: 1 }, previewCount, 29).authority).toEqual({ renewalRequired: false, reasons: [] })
  })

  it.each([
    { intervalUnit: "week", intervalCount: 1, covered: 7, uncovered: 8 },
    { intervalUnit: "month", intervalCount: 1, covered: 28, uncovered: 29 },
    { intervalUnit: "month", intervalCount: 2, covered: 59, uncovered: 60 },
    { intervalUnit: "month", intervalCount: 12, covered: 365, uncovered: 366 },
    { intervalUnit: "year", intervalCount: 1, covered: 365, uncovered: 366 },
  ] as const)("proves covered $intervalCount $intervalUnit intervals and rejects a stricter minimum", ({ intervalUnit, intervalCount, covered, uncovered }) => {
    const before = { ...current, intervalUnit, intervalCount, anchorDate: "2026-10-31", effectiveFrom: "2026-10-31" }
    expect(amend(before, {}, 0, covered).authority).toEqual({ renewalRequired: false, reasons: [] })
    expect(amend(before, {}, 0, uncovered).authority).toEqual({ renewalRequired: true, reasons: ["Charges are closer together than authorized"] })
  })

  it("uses Gregorian century rules and restores the month-end anchor after February", () => {
    const before = { ...current, intervalCount: 1, anchorDate: "2100-01-31", effectiveFrom: "2100-01-31", end: { type: "after_runs" as const, runs: 2 } }
    expect(amend(before, {}, 0, 29).authority?.renewalRequired).toBe(true)
    expect(amend({ ...before, anchorDate: "2000-01-31", effectiveFrom: "2000-01-31" }, {}, 0, 29).authority?.renewalRequired).toBe(false)
    expect(amend({ ...before, anchorDate: "2028-01-31", effectiveFrom: "2028-01-31" }, {}, 0, 29).authority?.renewalRequired).toBe(false)
    expect(amend({ ...before, anchorDate: "2028-01-31", effectiveFrom: "2028-01-31", end: { type: "none" } }, {}, 0, 29).authority?.renewalRequired).toBe(true)
  })

  it("preserves a leap-year annual interval only while the finite term covers it", () => {
    const before = { ...current, intervalUnit: "year" as const, intervalCount: 1, anchorDate: "2023-03-01", effectiveFrom: "2023-03-01", end: { type: "after_runs" as const, runs: 2 } }
    expect(amend(before, {}, 0, 366).authority).toEqual({ renewalRequired: false, reasons: [] })
    expect(amend({ ...before, end: { type: "none" } }, {}, 0, 366).authority?.renewalRequired).toBe(true)
    expect(amend({ ...before, anchorDate: "2024-02-29", effectiveFrom: "2024-02-29" }, {}, 0, 366).authority?.renewalRequired).toBe(true)
  })

  it("has no interval to check for zero or one future charge, but still checks charge amounts", () => {
    const single = { ...current, end: { type: "after_runs" as const, runs: 1 } }
    expect(amend(single, { intervalCount: 1 }, 0, 366).authority).toEqual({ renewalRequired: false, reasons: [] })
    expect(amend(single, { periodGrossMinor: "10001" }, 0, 366).authority).toEqual({ renewalRequired: true, reasons: ["A charge exceeds the authorized maximum"] })
    const ended = { ...current, end: { type: "on_date" as const, endsAt: "2026-09-01" } }
    expect(amend(ended, { intervalCount: 1, periodGrossMinor: "10001" }, 0, 366).authority).toEqual({ renewalRequired: false, reasons: [] })
  })

  it("checks the amount and currency independently of spacing and display length", () => {
    expect(amend(current, { periodGrossMinor: "10001", currency: "EUR" }, 0, 0).authority)
      .toEqual({ renewalRequired: true, reasons: ["Currency changed", "A charge exceeds the authorized maximum"] })
  })
})
