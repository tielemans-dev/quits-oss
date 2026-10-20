// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("../../../trpc/client", () => ({ trpc: { agreements: {
  capabilities: { query: async () => ({ manageTemplates: true }) },
  listTemplates: { query: async () => [] },
} } }))

import { I18nProvider } from "../../../lib/i18n/react"
import { AgreementTemplateManager } from "../template-manager"

afterEach(cleanup)

it("labels the terms plainly and says formatting is supported", async () => {
  render(<I18nProvider initialLocale="da-DK"><AgreementTemplateManager /></I18nProvider>)
  const terms = await screen.findByLabelText("Vilkår")
  expect(terms.tagName).toBe("TEXTAREA")
  expect(document.getElementById(terms.getAttribute("aria-describedby")!)?.textContent).toBe("Du kan formatere teksten med Markdown, fx **fed** og # overskrifter.")
  expect(screen.queryByText(/Vilkår \(Markdown\)/)).toBeNull()
})
