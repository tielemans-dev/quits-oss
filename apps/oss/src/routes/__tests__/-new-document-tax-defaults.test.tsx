// @vitest-environment jsdom
// MOCK: organization/session and settings transport fixtures are test-only; forms and hooks are real.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({ load: vi.fn(), settings: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: unknown) => options, useNavigate: () => vi.fn() }))
vi.mock("../../lib/active-organization", () => ({ useRequestOrganizationId: () => "synthetic-org" }))
vi.mock("../../lib/organization-settings-query", () => ({ loadOrganizationSettings: fixture.load }))
vi.mock("../../trpc/client", () => ({ trpc: {
  settings: { get: { query: fixture.settings } },
  contacts: { list: { query: async () => [] } },
  catalog: { list: { query: async () => [] } },
  runtime: { capabilities: { query: async () => ({ aiInvoiceDraft: { enabled: false } }) } },
} }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key, locale: "da-DK" }) }))

import { Route as InvoiceRoute } from "../_app/invoices/new"
import { Route as QuoteRoute } from "../_app/quotes/new"

describe.each([['invoice', InvoiceRoute], ['quote', QuoteRoute]] as const)("new %s saved tax default", (_kind, route) => {
  beforeEach(() => {
    fixture.load.mockReset()
    fixture.settings.mockResolvedValue({ baseCurrency: "DKK" })
  })
  afterEach(cleanup)
  it.each([25, 0, null])("shows saved rate %s in the actual form", async taxRate => {
    fixture.load.mockResolvedValue({ taxRate, pricesIncludeTax: false, defaultCurrency: "DKK" })
    const Component = (route as unknown as { component: () => React.ReactNode }).component
    const { container } = render(<Component />)
    await waitFor(() => expect((container.querySelector('input[max="100"]') as HTMLInputElement).value).toBe(String(taxRate ?? 0)))
    expect((container.querySelector('input[max="100"]') as HTMLInputElement).value).toBe(String(taxRate ?? 0))
  })
  it("preserves a rate edited before settings load", async () => {
    let resolve!: (settings: unknown) => void
    const pending = new Promise(r => { resolve = r })
    fixture.load.mockReturnValue(pending)
    const Component = (route as unknown as { component: () => React.ReactNode }).component
    const { container } = render(<Component />)
    const field = container.querySelector('input[max="100"]') as HTMLInputElement
    fireEvent.change(field, { target: { value: "12" } })
    resolve({ taxRate: 25, pricesIncludeTax: false, defaultCurrency: "DKK" })
    await waitFor(() => expect(field.value).toBe("12"))
  })
})


describe("new invoice payment-term defaults", () => {
  beforeEach(() => {
    fixture.load.mockReset()
    fixture.settings.mockResolvedValue({ baseCurrency: "DKK" })
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-12T22:30:00Z"))
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })
  it.each([[14, "27.10.2026"], [0, "13.10.2026"], [30, "12.11.2026"], [null, "docForm.selectDate"]])("uses saved term %s in the actual invoice form", async (paymentTermsDays, expected) => {
    fixture.load.mockResolvedValue({ paymentTermsDays, timezone: "Europe/Copenhagen", taxRate: 25 })
    const Component = (InvoiceRoute as unknown as { component: () => React.ReactNode }).component
    const { container } = render(<Component />)
    await waitFor(() => expect(container.querySelector('#dueDate')?.textContent).toContain(expected))
  })
  it.each([false, true])("preserves a calendar edit with cleared=%s while settings are pending", async cleared => {
    let resolve!: (settings: unknown) => void
    fixture.load.mockReturnValue(new Promise(r => { resolve = r }))
    const Component = (InvoiceRoute as unknown as { component: () => React.ReactNode }).component
    const { container } = render(<Component />)
    const field = container.querySelector('#dueDate') as HTMLButtonElement
    await act(async () => { fireEvent.click(field) })
    fireEvent.click(screen.getByRole("button", { name: /15.*oktober.*2026/i }))
    await waitFor(() => expect(container.querySelector('#dueDate')?.textContent).toContain("15.10.2026"))
    if (cleared) {
      if (!screen.queryByRole("button", { name: "docForm.clear" })) fireEvent.click(field)
      fireEvent.click(await screen.findByRole("button", { name: "docForm.clear" }))
    }
    resolve({ paymentTermsDays: 14, timezone: "Europe/Copenhagen", taxRate: 25 })
    await waitFor(() => expect(container.querySelector('#dueDate')?.textContent).toContain(cleared ? "docForm.selectDate" : "15.10.2026"))
  })
})
