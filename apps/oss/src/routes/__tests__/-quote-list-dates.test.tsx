// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

// MOCK: one synthetic quote, with no network or customer data.
vi.mock("../../trpc/client", () => ({ trpc: { quotes: { list: { query: async () => [{
  id: "mock-quote", number: "QUO-0001", status: "sent", issueDate: "2026-10-11T12:00:00Z",
  expiryDate: "2026-10-25T00:00:00Z", total: 1250, currency: "DKK", contact: { name: "MOCK Buyer" },
}] } } } }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children }: { children: React.ReactNode }) => <a href="/quotes/mock-quote">{children}</a>,
}))
vi.mock("../../components/status-badge", () => ({ StatusBadge: () => <span>Sent</span> }))

import { Route } from "../_app/quotes/index"
import { I18nProvider } from "../../lib/i18n/react"
const Page = (Route as unknown as { component: ComponentType }).component

afterEach(cleanup)
describe("quote list dates", () => {
  it.each([
    ["da-DK", "11. okt. 2026", "25. okt. 2026", "Gyldigt til"],
    ["en-US", "11 Oct 2026", "25 Oct 2026", "Valid until"],
  ])("uses short day-first issue and expiry dates in %s, including the compact row", async (locale, issue, expiry, label) => {
    render(<I18nProvider locale={locale}><Page /></I18nProvider>)
    const buyer = await screen.findByRole("link", { name: "MOCK Buyer" })
    const row = buyer.closest('[role="row"]')!
    expect(within(row as HTMLElement).getByText(issue).textContent).toBe(issue)
    expect(within(row as HTMLElement).getByText(expiry).textContent).toBe(expiry)
    expect(within(row as HTMLElement).getByText(`${label} ${expiry}`).textContent).toBe(`${label} ${expiry}`)
    expect(row.textContent).not.toContain("Oct 11, 2026")
    expect(row.textContent).not.toContain("11. oktober 2026")
  })
})
