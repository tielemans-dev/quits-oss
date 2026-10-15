// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options, useParams: () => ({ contactId: "synthetic-buyer" }) }),
  useNavigate: () => vi.fn(),
}))
vi.mock("../../trpc/client", () => ({ trpc: {
  contacts: { get: { query: async () => ({ id: "synthetic-buyer", name: "Synthetic Buyer", country: "DK" }) } },
  settings: { get: { query: async () => ({ countryCode: "DK" }) } },
} }))
import { Route as NewRoute } from "../_app/contacts/new"
import { Route as EditRoute } from "../_app/contacts/$contactId"
const pages = [["new", NewRoute], ["edit", EditRoute]] as const
afterEach(cleanup)
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
})
