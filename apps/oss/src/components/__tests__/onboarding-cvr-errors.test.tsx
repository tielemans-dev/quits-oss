// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AiAssistantPanel } from "../onboarding/ai-assistant-panel"
import { CompanyReview } from "../onboarding/company-review"
import { I18nProvider } from "../../lib/i18n/react"
import { translate } from "../../lib/i18n/translate"

const api = vi.hoisted(() => ({ prepare: vi.fn(async () => ({ token: "signed" })), confirm: vi.fn(),
  suggest: vi.fn(async () => ({ patch: { primaryTaxId: "24256790" }, rationale: "Synthetic suggestion", confidence: 1, followupQuestions: [] })), apply: vi.fn() }))
vi.mock("../../trpc/client", () => ({ trpc: {
  runtime: { prepareSellerVatConfirmation: { mutate: api.prepare } },
  onboarding: { confirmV2: { mutate: api.confirm } },
  onboardingAi: { suggestOnboardingPatch: { mutate: api.suggest }, applyOnboardingPatch: { mutate: api.apply } },
} }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const company = { companyName: "Synthetic Seller", companyAddress: "Testvej 1", cvr: "24256790", companyForm: "ApS" }

describe.each(["da", "en-US"])("onboarding CVR errors in %s", locale => {
  it.each(["cvr.invalid", "cvr.inactive", "cvr.unavailable", "cvr.alreadyRegistered"] as const)("translates %s in company review", async key => {
    api.confirm.mockRejectedValueOnce(new Error(key))
    const done = vi.fn()
    const { container } = render(<I18nProvider locale={locale}><CompanyReview company={company} confirmationEnabled nonVatEnabled onComplete={done} /></I18nProvider>)
    fireEvent.click(screen.getAllByRole("radio")[1]!)
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(translate(key, locale)))
    expect(screen.queryByText(key)).toBeNull()
    expect(done).not.toHaveBeenCalled()
  })
  it.each(["cvr.invalid", "cvr.inactive", "cvr.unavailable", "cvr.alreadyRegistered"] as const)("translates %s when applying an AI patch", async key => {
    api.apply.mockRejectedValueOnce(new Error(key))
    const applied = vi.fn()
    render(<I18nProvider locale={locale}><AiAssistantPanel values={{}} missing={[]} onApplied={applied} /></I18nProvider>)
    fireEvent.change(screen.getByLabelText(translate("auth.onboarding.ai.prompt", locale)), { target: { value: "Synthetic company" } })
    fireEvent.click(screen.getByRole("button", { name: translate("auth.onboarding.ai.suggest", locale) }))
    fireEvent.click(await screen.findByRole("button", { name: translate("auth.onboarding.ai.apply", locale) }))
    expect(await screen.findByText(translate(key, locale))).toBeTruthy()
    expect(screen.queryByText(key)).toBeNull()
    expect(applied).not.toHaveBeenCalled()
  })
})
