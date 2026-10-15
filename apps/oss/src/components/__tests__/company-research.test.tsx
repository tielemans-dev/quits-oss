// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"
import { OnboardingV2 } from "../onboarding-v2/onboarding-v2"
import { draftKey, newDraft, storeDraft } from "../onboarding-v2/draft"
import { companyStarters } from "../../lib/onboarding/company-starters"
const company = { cvr: "24256790", name: "Test ApS", address: "Testvej 1", companyForm: "ApS",
  industryCode: "620100", status: "active", statusClass: "active", momsRegistered: true } as const
afterEach(() => { cleanup(); sessionStorage.clear() })
it.each(["pending", "failure", "dismiss", "accept"])("keeps confirmation independent of %s research and requires selection", async mode => {
  storeDraft(draftKey("u", "o"), newDraft(company, "test@example.test", true))
  let finish!: (value: ReturnType<typeof companyStarters>) => void
  const suggestions = vi.fn(() => mode === "failure" ? Promise.reject(new Error("offline"))
    : new Promise<ReturnType<typeof companyStarters>>(resolve => { finish = resolve }))
  const confirm = vi.fn(async () => ({ status: "complete" as const }))
  render(<I18nProvider locale="en-US"><OnboardingV2 userId="u" organizationId="o" signupEmail="test@example.test"
    onComplete={vi.fn()} client={{ get: vi.fn(), search: vi.fn(), suggestions, confirm }} /></I18nProvider>)
  const checkbox = await screen.findByRole("checkbox", { name: /Softwareudvikling/ })
  expect((checkbox as HTMLInputElement).checked).toBe(false)
  if (mode === "accept") fireEvent.click(checkbox)
  if (mode === "dismiss") {
    fireEvent.click(screen.getByRole("button", { name: "Remove Softwareudvikling" }))
    await act(async () => finish(companyStarters(company)))
    expect(screen.queryByRole("checkbox", { name: /Softwareudvikling/ })).toBeNull()
  }
  fireEvent.click(screen.getByRole("button", { name: "Confirm and create" }))
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
  const payload = confirm.mock.calls[0] as unknown as [Record<string, unknown>]
  if (mode === "accept") expect(payload[0].catalogSuggestions).toMatchObject([{ name: "Softwareudvikling" }])
  else expect(payload[0]).not.toHaveProperty("catalogSuggestions")
})
