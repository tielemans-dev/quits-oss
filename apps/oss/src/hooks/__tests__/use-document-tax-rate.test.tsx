// @vitest-environment jsdom
// MOCK: organization/session and settings transport fixtures are test-only; forms and hooks are real.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDocumentTaxRate } from "../use-document-tax-rate"

const fixture = vi.hoisted(() => ({ organizationId: "org-a", load: vi.fn() }))
vi.mock("../../lib/active-organization", () => ({ useRequestOrganizationId: () => fixture.organizationId }))
vi.mock("../../lib/organization-settings-query", () => ({ loadOrganizationSettings: fixture.load }))

describe("new document tax defaults", () => {
  beforeEach(() => { fixture.organizationId = "org-a"; fixture.load.mockReset() })
  afterEach(cleanup)
  it.each([25, 0, 7.5, null])("loads saved rate %s including self-host and unset defaults", async taxRate => {
    fixture.load.mockResolvedValue({ taxRate })
    const { result } = renderHook(useDocumentTaxRate)
    await waitFor(() => expect(result.current[0]).toBe(String(taxRate ?? 0)))
  })
  const dk = { countryCode: "DK", taxRegime: "eu_vat" }
  it.each([
    [{ ...dk, taxRate: 25, momsRegistered: true }, "25"],
    [{ ...dk, taxRate: 25, momsRegistered: false }, "0"],
    [{ ...dk, taxRate: 0, momsRegistered: false }, "0"],
    [{ ...dk, taxRate: 25, momsRegistered: null }, "25"],
    [{ countryCode: "dk", taxRegime: "eu_vat", taxRate: 25, momsRegistered: false }, "0"],
    [{ countryCode: " DK ", taxRegime: "eu_vat", taxRate: 25, momsRegistered: false }, "0"],
    [{ countryCode: "DK", taxRegime: "custom", taxRate: 25, momsRegistered: false }, "25"],
    [{ countryCode: "US", taxRegime: "us_sales_tax", taxRate: 7.5, momsRegistered: false }, "7.5"],
    [{ countryCode: "DE", taxRegime: "eu_vat", taxRate: 19, momsRegistered: false }, "19"],
  ])("applies the seller VAT status to saved %j", async (settings, expected) => {
    fixture.load.mockResolvedValue(settings)
    const { result } = renderHook(useDocumentTaxRate)
    await waitFor(() => expect(result.current[0]).toBe(expected))
  })
  it("still lets a non-VAT seller's explicit choice win", async () => {
    fixture.load.mockResolvedValue({ ...dk, taxRate: 25, momsRegistered: false })
    const { result } = renderHook(useDocumentTaxRate)
    await waitFor(() => expect(result.current[0]).toBe("0"))
    act(() => result.current[1]("12"))
    expect(result.current[0]).toBe("12")
  })
  it.each(["0", "12", ""])("preserves explicit user/AI rate %s when settings arrive late", async chosen => {
    let resolve!: (settings: { taxRate: number }) => void
    fixture.load.mockReturnValue(new Promise(r => { resolve = r }))
    const { result } = renderHook(useDocumentTaxRate)
    act(() => result.current[1](chosen))
    await act(async () => resolve({ taxRate: 25 }))
    expect(result.current[0]).toBe(chosen)
  })
  it("keeps the default on failure and accepts edits", async () => {
    fixture.load.mockRejectedValue(new Error("Unavailable"))
    const { result } = renderHook(useDocumentTaxRate)
    await act(async () => {})
    expect(result.current[0]).toBe("0")
    act(() => result.current[1]("20"))
    expect(result.current[0]).toBe("20")
  })
  it("ignores another organization's pending load and resets its edited rate", async () => {
    let resolve!: (settings: { taxRate: number }) => void
    fixture.load.mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValueOnce({ taxRate: 5 })
    const { result, rerender } = renderHook(useDocumentTaxRate)
    act(() => result.current[1]("12"))
    fixture.organizationId = "org-b"
    rerender()
    await waitFor(() => expect(result.current[0]).toBe("5"))
    await act(async () => resolve({ taxRate: 25 }))
    expect(result.current[0]).toBe("5")
  })
})
