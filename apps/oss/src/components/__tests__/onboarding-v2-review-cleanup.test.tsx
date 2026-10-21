// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CvrCompany } from "@quits/contracts/cvr"
import { I18nProvider } from "../../lib/i18n/react"
import { translate } from "../../lib/i18n/translate"
import { stageSelectedCompany } from "../../lib/onboarding/selected-company"
import { OnboardingV2 } from "../onboarding-v2/onboarding-v2"
import type { OnboardingV2Client } from "../onboarding-v2/client"
import { draftKey, newDraft, storeDraft, type OnboardingDraft } from "../onboarding-v2/draft"

afterEach(() => { cleanup(); sessionStorage.clear() })

const company = (momsRegistered: boolean): CvrCompany => ({ cvr: "24256790", name: "Synthetic Studio ApS", address: "Testvej 1", companyForm: "ApS", status: "active", statusClass: "active", momsRegistered })
const client = (overrides: Partial<OnboardingV2Client> = {}): OnboardingV2Client => ({
  search: async () => [],
  get: async () => null,
  suggestions: async () => ({ customers: [], lines: [] }),
  confirm: vi.fn(async () => ({ status: "complete" as const })),
  ...overrides,
})
const b2b = `${translate("auth.onboarding.b2bOnly", "da-DK")}. ${translate("auth.onboarding.cvrFree", "da-DK")}`

function show(draft: OnboardingDraft | null, props: { nonVatEnabled?: boolean; confirmationEnabled?: boolean; client?: OnboardingV2Client } = {}) {
  if (draft) storeDraft(draftKey("synthetic-user", "synthetic-org"), draft)
  render(<I18nProvider locale="da-DK"><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" nonVatEnabled={props.nonVatEnabled ?? true} confirmationEnabled={props.confirmationEnabled} client={props.client ?? client()} onComplete={() => {}} /></I18nProvider>)
}

describe("non-VAT sellers (QUI-241)", () => {
  it.each([true, false])("shows the rate and VAT-inclusive prices only to registered sellers (registered=%s)", async registered => {
    show(newDraft(company(registered), "signup@example.test", false))
    await screen.findByLabelText("Navn")
    expect(screen.queryByLabelText("Moms %") !== null).toBe(registered)
    expect(screen.queryByRole("combobox", { name: "Priser inkl. moms" }) !== null).toBe(registered)
    expect(screen.queryByText(translate("vatStatus.noHint", "da-DK")) !== null).toBe(!registered)
  })

  it("drops VAT-inclusive prices when the seller confirms they are not registered", async () => {
    const api = client()
    const draft = newDraft(company(true), "signup@example.test", false)
    draft.values.pricesIncludeTax = true
    show(draft, { confirmationEnabled: true, client: api })
    fireEvent.click(await screen.findByRole("radio", { name: translate("vatStatus.no", "da-DK") }))
    expect(screen.queryByLabelText("Moms %")).toBeNull()
    expect(screen.queryByRole("combobox", { name: "Priser inkl. moms" })).toBeNull()
    expect(screen.getByText(translate("vatStatus.noHint", "da-DK"))).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Bekræft og opret" }))
    await waitFor(() => expect(api.confirm).toHaveBeenCalledOnce())
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: false, settings: expect.objectContaining({ taxRate: 0, pricesIncludeTax: false }) }))
  })
})

describe("suggestions (QUI-241)", () => {
  it("shows no customer types and never a 0 kr. price", async () => {
    const draft = newDraft(company(true), "signup@example.test", true)
    draft.suggestionsState = "ready"
    draft.suggestions = {
      customers: [{ id: "c", label: "Private husstande" }],
      lines: [{ id: "free", description: "Rengøring", unit: "hour", unitPrice: 0 }, { id: "priced", description: "Design", unit: "hour", unitPrice: 850 }],
    }
    show(draft)
    const free = await screen.findByRole("checkbox", { name: "Rengøring" })
    expect(free.closest("label")!.textContent).toBe("Rengøring")
    expect(screen.getByRole("checkbox", { name: /^Design · 850,00\s?kr\. pr\. time$/ })).toBeTruthy()
    expect(screen.queryByText("Private husstande")).toBeNull()
    expect(screen.queryByText("Typiske kunder")).toBeNull()
  })
})

describe("manual setup (QUI-241)", () => {
  it("leaves the company type unanswered with sole traders first", async () => {
    show(null)
    fireEvent.click(screen.getByRole("button", { name: "Opsæt manuelt i stedet" }))
    const form = screen.getByRole("combobox", { name: "Selskabsform" }) as HTMLSelectElement
    expect(form.value).toBe("")
    expect(Array.from(form.options).map(option => option.value)).toEqual(["", "Enkeltmandsvirksomhed", "Interessentskab", "ApS", "A/S"])
    fireEvent.click(screen.getByRole("button", { name: "Opret virksomhed" }))
    expect(await screen.findByRole("link", { name: /^Selskabsform:/ })).toBeTruthy()
    expect(form.getAttribute("aria-invalid")).toBe("true")
  })
})

describe("review screen noise (QUI-241)", () => {
  it("drops source badges, the duplicate unsaved card, the edit hint and the B2B notice", async () => {
    show(newDraft(company(true), "signup@example.test", false))
    await screen.findByLabelText("Navn")
    for (const text of ["FRA CVR", "STANDARD", "Intet er gemt endnu", "Tryk på en linje for at rette", b2b]) {
      expect(screen.queryByText(text)).toBeNull()
    }
    expect(screen.getByText("Intet gemmes, før du bekræfter")).toBeTruthy()
  })

  it("marks only fields that still need an answer", async () => {
    show(newDraft(company(true), "signup@example.test", false))
    const name = await screen.findByLabelText("Navn")
    const star = () => name.closest(".ob-field")!.querySelector(".ob-field-label [aria-hidden=true]")
    expect(star()).toBeNull()
    fireEvent.change(name, { target: { value: "" } })
    expect(star()?.textContent).toBe(" *")
  })

  it("shows the B2B notice on the search screen, but not while a company picked earlier loads", async () => {
    show(null)
    expect(screen.getByText(b2b)).toBeTruthy()
    cleanup()
    stageSelectedCompany("synthetic-user", "synthetic-org", { name: "Synthetic Studio ApS", cvr: "24256790" })
    show(null, { client: client({ get: () => new Promise(() => {}) }) })
    expect(screen.queryByText(b2b)).toBeNull()
  })
})
