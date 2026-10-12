// @vitest-environment jsdom
// MOCK: organization/session and settings transport fixtures are test-only.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invoiceDueDate, useInvoiceDueDate } from "../use-invoice-due-date"
const fixture = vi.hoisted(() => ({ organizationId: "org-a", load: vi.fn() }))
vi.mock("../../lib/active-organization", () => ({ useRequestOrganizationId: () => fixture.organizationId }))
vi.mock("../../lib/organization-settings-query", () => ({ loadOrganizationSettings: fixture.load }))
describe("invoice due-date defaults", () => {
  beforeEach(() => { fixture.organizationId = "org-a"; fixture.load.mockReset() })
  afterEach(cleanup)
  it("uses calendar days across DST, year boundaries, and organization time zones", () => {
    expect(invoiceDueDate(14, "Europe/Copenhagen", new Date("2026-10-12T22:30:00Z"))).toBe("2026-10-27")
    expect(invoiceDueDate(14, "America/New_York", new Date("2026-10-12T22:30:00Z"))).toBe("2026-10-26")
    expect(invoiceDueDate(14, "Europe/Copenhagen", new Date("2026-12-25T12:00:00Z"))).toBe("2027-01-08")
  })
  it("ignores an old organization's pending response and resets the edited date", async () => {
    let resolve!: (settings: unknown) => void
    fixture.load.mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValueOnce({ paymentTermsDays: 0, timezone: "UTC" })
    const { result, rerender } = renderHook(useInvoiceDueDate)
    act(() => result.current[1]("2099-01-01"))
    fixture.organizationId = "org-b"
    rerender()
    await waitFor(() => expect(result.current[0]).toBe(invoiceDueDate(0, "UTC")))
    await act(async () => resolve({ paymentTermsDays: 365, timezone: "UTC" }))
    expect(result.current[0]).toBe(invoiceDueDate(0, "UTC"))
  })
  it("leaves an unset date editable when settings fail", async () => {
    fixture.load.mockRejectedValue(new Error("Unavailable"))
    const { result } = renderHook(useInvoiceDueDate)
    await act(async () => {})
    expect(result.current[0]).toBe("")
    act(() => result.current[1]("2026-12-01"))
    expect(result.current[0]).toBe("2026-12-01")
  })
})
