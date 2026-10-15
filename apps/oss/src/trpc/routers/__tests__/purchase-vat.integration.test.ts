import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { exportsRouter } from "../exports"
import { tastSelvSummary } from "../../../lib/exports/vat-overview"
import { ensureTestMembership } from "../../../test-utils/membership"

describe.skipIf(!hasTestDatabase)("manual purchase VAT", () => {
  let a: Awaited<ReturnType<typeof createTestOrganization>>
  let b: typeof a
  const caller = (org: typeof a, userId = org.actors.admin.userId, requestedOrganizationId = org.organizationId) => exportsRouter.createCaller({
    requestedOrganizationId, session: { user: { id: userId, name: "Example", email: "example@example.test" }, session: { activeOrganizationId: org.organizationId } },
  } as never)
  const period = { from: "2026-07-01", to: "2026-09-30" }
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z"))
    for (const assign of [(org: typeof a) => { a = org }, (org: typeof a) => { b = org }]) {
      const org = await createTestOrganization({ roles: ["admin", "accountant", "member"], settings: { countryCode: "DK", taxRegime: "eu_vat", timezone: "Europe/Copenhagen", currency: "DKK" } })
      assign(org)
      await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: { vatPeriod: "quarterly" } })
    }
    const contact = await prisma.contact.create({ data: { organizationId: a.organizationId, name: "Example" } })
    for (const [date, tax, status] of [["2026-06-30T21:59:59Z", "99", "sent"], ["2026-06-30T22:00:00Z", "75.01", "sent"], ["2026-09-30T21:59:59Z", "0.02", "sent"], ["2026-09-30T22:00:00Z", "88", "sent"], ["2026-08-01T12:00:00Z", "77", "draft"]]) {
      await prisma.invoice.create({ data: { organizationId: a.organizationId, contactId: contact.id, status, issueDate: new Date(date!), dueDate: new Date(), currency: "DKK", subtotalNet: "0", totalTax: tax!, totalGross: tax! } })
    }
  })
  afterAll(async () => { vi.useRealTimers(); await a?.cleanup(); await b?.cleanup() })
  it("stores exact øre, edits audit metadata, clears without deleting, and scopes both reads and writes", async () => {
    const api = caller(a)
    expect(await api.vatOverview()).toMatchObject({ outputVatMinor: "7503", inputVatMinor: null, payableVatMinor: null })
    for (const [amount, inputVatMinor, payableVatMinor] of [["0", "0", "7503"], ["25,02", "2502", "5001"], ["100.04", "10004", "-2501"]]) {
      vi.setSystemTime(new Date(Date.now() + 1000))
      const result = await api.setPurchaseVat({ ...period, amount: amount! })
      expect(result).toMatchObject({ inputVatMinor, payableVatMinor, inputVatUpdatedBy: a.actors.admin.userId, inputVatUpdatedAt: new Date().toISOString() })
      if (!result.available) throw new Error("Expected available overview")
      expect(tastSelvSummary(result).csv).toContain(`Moms i alt,${payableVatMinor === "-2501" ? "-25.01" : payableVatMinor === "5001" ? "50.01" : "75.03"},`)
    }
    expect(await caller(b).vatOverview()).toMatchObject({ inputVatMinor: null })
    await caller(b).setPurchaseVat({ ...period, amount: "1.01" })
    expect(await api.vatOverview()).toMatchObject({ inputVatMinor: "10004" })
    await expect(caller(b, a.actors.admin.userId).setPurchaseVat({ ...period, amount: "999" })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(caller(a, a.actors.admin.userId, b.organizationId).setPurchaseVat({ ...period, amount: "999" })).rejects.toMatchObject({ code: "CONFLICT" })
    for (const role of ["accountant", "member"] as const) await expect(caller(a, a.actors[role].userId).setPurchaseVat({ ...period, amount: "1" })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await ensureTestMembership(a.organizationId, b.actors.admin.userId, "admin")
    expect(await caller(a, b.actors.admin.userId).setPurchaseVat({ ...period, amount: "9999999999999999.99" }))
      .toMatchObject({ inputVatMinor: "999999999999999999", payableVatMinor: "-999999999999992496", inputVatUpdatedBy: b.actors.admin.userId })
    await api.setPurchaseVat({ ...period, amount: null })
    expect(await api.vatOverview()).toMatchObject({ inputVatMinor: null, payableVatMinor: null })
    expect(await prisma.vatPeriodEntry.findMany({ where: { organizationId: a.organizationId } })).toMatchObject([{ inputVat: null, updatedBy: a.actors.admin.userId }])
  })
  it.each(["-1", "1.001", "NaN", "Infinity", "1e2", "", "10000000000000000", 1.25])("rejects invalid amount %s", async amount => {
    await expect(caller(a).setPurchaseVat({ ...period, amount: amount as string })).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })
  it("keeps periods separate on a deadline boundary and on a frequency change", async () => {
    const api = caller(a)
    await api.setPurchaseVat({ ...period, amount: "12.34" })
    await prisma.orgSettings.update({ where: { organizationId: a.organizationId }, data: { vatPeriod: "half_yearly" } })
    expect(await api.vatOverview()).toMatchObject({ inputVatMinor: null })
    await expect(api.setPurchaseVat({ ...period, amount: "2" })).rejects.toMatchObject({ code: "CONFLICT" })
    await api.setPurchaseVat({ from: period.from, to: "2026-12-31", amount: "56.78" })
    await prisma.orgSettings.update({ where: { organizationId: a.organizationId }, data: { vatPeriod: "quarterly" } })
    vi.setSystemTime(new Date("2026-12-01T22:59:59Z"))
    expect(await api.vatOverview()).toMatchObject({ inputVatMinor: "1234" })
    vi.setSystemTime(new Date("2026-12-01T23:00:00Z"))
    expect(await api.vatOverview()).toMatchObject({ period: { from: "2026-10-01" }, inputVatMinor: null })
    await expect(api.setPurchaseVat({ ...period, amount: "2" })).rejects.toMatchObject({ code: "CONFLICT" })
  })
})
