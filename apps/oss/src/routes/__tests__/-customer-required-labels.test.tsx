// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options, useParams: () => ({ contactId: "synthetic-buyer" }), useSearch: () => ({ edit: true }) }),
  Link: () => null,
  useNavigate: () => vi.fn(),
}))
const readiness = vi.hoisted(() => ({ businessBuyersOnly: false }))
vi.mock("../../trpc/client", () => ({ trpc: {
  invoices: { sendReadiness: { query: async () => ({ businessBuyersOnly: readiness.businessBuyersOnly }) } },
  contacts: { get: { query: async () => ({ id: "synthetic-buyer", name: "Synthetic Buyer", country: "DK" }) } },
  settings: { get: { query: async () => ({ countryCode: "DK" }) } },
  cvr: { customerAvailable: { query: async () => ({ enabled: false }) } },
} }))
import { Route as NewRoute } from "../_app/contacts/new"
import { Route as EditRoute } from "../_app/contacts/$contactId"
const pages = [["new", NewRoute], ["edit", EditRoute]] as const
afterEach(() => { cleanup(); readiness.businessBuyersOnly = false })
describe("customer required labels", () => {
  it.each(pages)("labels the required name in Danish and English on the %s screen", async (_name, route) => {
    const Page = (route as unknown as { component: ComponentType }).component
    for (const [locale, label] of [["da-DK", "Navn (påkrævet)"], ["en-US", "Name (required)"]]) {
      render(<I18nProvider locale={locale}><Page /></I18nProvider>)
      const input = await screen.findByLabelText(label) as HTMLInputElement
      expect(input.required).toBe(true)
      expect(screen.queryByLabelText(/\*/)).toBeNull()
      cleanup()
    }
  })
  it.each(pages)("shows the business-only hint on the %s screen only when an issuance policy limits customers to businesses", async (_name, route) => {
    const Page = (route as unknown as { component: ComponentType }).component
    render(<I18nProvider locale="en-US"><Page /></I18nProvider>)
    await screen.findByLabelText("Name (required)")
    expect(screen.queryByText("Customers must be businesses.")).toBeNull()
    cleanup()
    readiness.businessBuyersOnly = true
    render(<I18nProvider locale="en-US"><Page /></I18nProvider>)
    expect(await screen.findByText("Customers must be businesses.")).toBeTruthy()
  })
})
