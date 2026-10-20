// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import type { ComponentType, ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

// MOCK: synthetic agreements, with no network or customer data.
vi.mock("../../trpc/client", () => ({ trpc: { agreements: { list: { query: async () => [{
  id: "mock-sent", number: "AGR-0001", status: "sent", title: "MOCK Website", validUntil: new Date("2026-12-31T00:00:00Z"),
  total: 56250, currency: "DKK", contact: { name: "MOCK Buyer" },
}, {
  id: "mock-draft", number: null, status: "draft", title: "MOCK Support", validUntil: new Date("2026-12-31T00:00:00Z"),
  total: 15625, currency: "DKK", contact: { name: "MOCK Other Buyer" },
}] } } } }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children, params, to, ...props }: { children: ReactNode; to: string; params?: { agreementId?: string } } & Record<string, unknown>) => (
    <a href={params?.agreementId ? to.replace("$agreementId", params.agreementId) : to} {...props}>{children}</a>
  ),
}))
vi.mock("../../components/agreements/template-manager", () => ({ AgreementTemplateManager: () => null }))
vi.mock("../../components/status-badge", () => ({ StatusBadge: ({ status }: { status: string }) => <span>{`status:${status}`}</span> }))

import { Route } from "../_app/agreements/index"
import { I18nProvider } from "../../lib/i18n/react"
const Page = (Route as unknown as { component: ComponentType }).component

afterEach(cleanup)
describe("agreement list", () => {
  it("shows each agreement's number, customer, total and status, as the quote list does", async () => {
    render(<I18nProvider locale="da-DK"><Page /></I18nProvider>)
    const link = await screen.findByRole("link", { name: "Aftale AGR-0001, MOCK Website, MOCK Buyer" })
    expect(link.getAttribute("href")).toBe("/agreements/mock-sent")
    const row = within(link.closest('[role="row"]') as HTMLElement)
    expect(row.getByText("AGR-0001")).toBeTruthy()
    expect(row.getByText("MOCK Buyer")).toBeTruthy()
    expect(row.getByText("status:sent")).toBeTruthy()
    expect(link.closest('[role="row"]')!.textContent).toContain("56.250")
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Titel", "Nummer", "Gyldig til", "I alt", "Status"])
  })

  it("names a draft without a number and links the whole row", async () => {
    render(<I18nProvider locale="en-US"><Page /></I18nProvider>)
    const link = await screen.findByRole("link", { name: "Draft agreement, MOCK Support, MOCK Other Buyer" })
    expect(link.getAttribute("href")).toBe("/agreements/mock-draft")
    // The stretched link is what makes a click anywhere on the row open the agreement.
    expect(link.className).toContain("after:inset-0")
    expect(within(link.closest('[role="row"]') as HTMLElement).getByText("Draft").className).toContain("sr-only")
  })
})
