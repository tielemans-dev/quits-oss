import { expect, it, vi } from "vitest"
import { Prisma } from "../../../../generated/prisma/browser"
import { vatOverview } from "../vat-overview"
import { nextVatReportingPeriod } from "../../vat-deadline"

const setup = (patch = {}) => ({
  orgSettings: { findUnique: vi.fn().mockResolvedValue({ momsRegistered: true, countryCode: "DK", taxRegime: "eu_vat", vatPeriod: "quarterly", timezone: "Europe/Copenhagen", ...patch }) },
  invoice: { findMany: vi.fn().mockResolvedValue([{ currency: "DKK", totalTax: new Prisma.Decimal("100.01") }, { currency: "DKK", totalTax: new Prisma.Decimal("0.02") }]) },
  creditNote: { findMany: vi.fn().mockResolvedValue([{ currency: "DKK", totalTax: new Prisma.Decimal("25.02") }]) },
})
it.each([
  ["quarterly", "2026-10-15", "Q3", "2026-07-01", "2026-09-30", "2026-12-01"],
  ["half_yearly", "2026-10-15", "H2", "2026-07-01", "2026-12-31", "2027-03-01"],
  ["quarterly", "2026-01-01", "Q4", "2025-10-01", "2025-12-31", "2026-03-02"],
  ["half_yearly", "2026-01-01", "H2", "2025-07-01", "2025-12-31", "2026-03-02"],
] as const)("maps %s on %s to its reporting dates", (type, today, label, from, to, date) => {
  expect(nextVatReportingPeriod(type, today)).toMatchObject({ label, from, to, date })
})
it.each(["quarterly", "half_yearly"])("reconciles %s issued tax less credits in exact øre", async vatPeriod => {
  const db = setup({ vatPeriod })
  const result = await vatOverview(db as never, "org", new Date("2026-10-15T12:00:00Z"))
  expect(result).toMatchObject({ available: true, outputVatMinor: "7501" })
  const args = db.invoice.findMany.mock.calls[0]![0]
  expect(args.where).toMatchObject({ organizationId: "org", status: { not: "draft" }, issueDate: { gte: new Date("2026-06-30T22:00:00Z") } })
  expect(args.where.issueDate.lt).toEqual(new Date(vatPeriod === "quarterly" ? "2026-09-30T22:00:00Z" : "2026-12-31T23:00:00Z"))
  expect(db.creditNote.findMany).toHaveBeenCalledWith(args)
})
it.each([{ momsRegistered: false }, { momsRegistered: null }, { countryCode: "SE" }, { taxRegime: "none" }, { vatPeriod: null }])("does not invent an overview for %j", async patch => {
  const db = setup(patch)
  expect(await vatOverview(db as never, "org")).toMatchObject({ available: false })
  expect(db.invoice.findMany).not.toHaveBeenCalled()
})
it("refuses mixed currency, supports refunds and sums beyond safe JS integers", async () => {
  const db = setup()
  db.invoice.findMany.mockResolvedValue([{ currency: "EUR", totalTax: new Prisma.Decimal("1") }])
  expect(await vatOverview(db as never, "org")).toMatchObject({ available: false, reason: "currency" })
  db.invoice.findMany.mockResolvedValue([])
  expect(await vatOverview(db as never, "org")).toMatchObject({ outputVatMinor: "-2502" })
  db.invoice.findMany.mockResolvedValue([{ currency: "DKK", totalTax: new Prisma.Decimal("900719925474099.99") }])
  expect(await vatOverview(db as never, "org")).toMatchObject({ outputVatMinor: "90071992547407497" })
})
