// @vitest-environment jsdom
// MOCK: organization/session and settings transport fixtures are test-only; forms and hooks are real.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
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
