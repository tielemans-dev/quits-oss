import { describe, expect, it } from "vitest"

import { nextVatDeadline } from "../vat-deadline"

describe("nextVatDeadline", () => {
  it.each([
    ["2026-02-10", "Q4", "2026-03-02", 20], // 1 Mar 2026 is a Sunday: the deadline moves to Monday
    ["2026-03-03", "Q1", "2026-06-01", 90],
    ["2026-06-02", "Q2", "2026-09-01", 91],
    ["2026-10-14", "Q3", "2026-12-01", 48],
    ["2026-12-02", "Q4", "2027-03-01", 89],
  ])("quarterly on %s reports %s, due %s", (today, label, date, daysLeft) => {
    expect(nextVatDeadline("quarterly", today)).toEqual({ label, date, daysLeft })
  })

  it.each([
    ["2026-02-01", "H2", "2026-03-02", 29],
    ["2026-03-03", "H1", "2026-09-01", 182],
    ["2026-10-14", "H2", "2027-03-01", 138],
  ])("half-yearly on %s reports %s, due %s", (today, label, date, daysLeft) => {
    expect(nextVatDeadline("half_yearly", today)).toEqual({ label, date, daysLeft })
  })

  it("counts the deadline day itself, and the next period starts the day after", () => {
    expect(nextVatDeadline("quarterly", "2026-12-01")).toMatchObject({ label: "Q3", daysLeft: 0 })
    expect(nextVatDeadline("quarterly", "2026-12-02").label).toBe("Q4")
    expect(nextVatDeadline("half_yearly", "2026-09-01")).toMatchObject({ label: "H1", daysLeft: 0 })
  })

  it("carries the last period of one year into the next", () => {
    expect(nextVatDeadline("quarterly", "2026-12-31")).toMatchObject({ label: "Q4", date: "2027-03-01" })
    expect(nextVatDeadline("quarterly", "2027-01-05")).toMatchObject({ label: "Q4", date: "2027-03-01" })
    expect(nextVatDeadline("half_yearly", "2027-01-05")).toMatchObject({ label: "H2", date: "2027-03-01" })
  })

  it("moves a Saturday deadline to Monday", () => {
    expect(nextVatDeadline("quarterly", "2025-02-10")).toMatchObject({ label: "Q4", date: "2025-03-03" })
  })
})
