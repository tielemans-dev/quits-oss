// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"
import { translate } from "../../lib/i18n/translate"
import { OnboardingV2 } from "../onboarding-v2/onboarding-v2"
import { readSelectedCompany, stageSelectedCompany } from "../../lib/onboarding/selected-company"
import { createOnboardingV2Client } from "../onboarding-v2/client"
import { confirmationPayload, draftKey, newDraft, storeDraft } from "../onboarding-v2/draft"

const api = vi.hoisted(() => ({ prepare: vi.fn(async () => ({ token: "signed-final-identity" })), confirm: vi.fn(async (_input: unknown) => ({ status: "complete" as const })) }))
vi.mock("../../trpc/client", () => ({ trpc: {
  runtime: { prepareSellerVatConfirmation: { mutate: api.prepare } },
  onboarding: { confirmV2: { mutate: api.confirm } },
} }))
afterEach(() => { vi.useRealTimers(); cleanup(); sessionStorage.clear(); vi.clearAllMocks() })

describe("staged company verification", () => {
  it("does not restore the staged company after the user replaces it and reloads", () => {
    const client = { ...createOnboardingV2Client(false), get: vi.fn(() => new Promise<null>(() => {})) }
    stageSelectedCompany("synthetic-user", "synthetic-org", { name: "Original ApS", cvr: "24256790" })
    vi.useFakeTimers()
    const ui = <I18nProvider locale="en-US"><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" client={client} onComplete={() => {}} /></I18nProvider>
    const view = render(ui)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Replacement" } })
    view.unmount()
    render(ui)
    expect(client.get).toHaveBeenCalledOnce()
  })
  it.each([true, false])("avoids parallel registry searches and handles verification success=%s", async success => {
    const company = { cvr: "24256790", name: "Selected ApS", address: "Testvej 1", companyForm: "ApS", status: "active", statusClass: "active", momsRegistered: false } as const
    let finish!: (value: typeof company | null) => void
    const result = new Promise<typeof company | null>(resolve => { finish = resolve })
    const client = { ...createOnboardingV2Client(false), get: vi.fn(() => result), search: vi.fn(async () => []) }
    stageSelectedCompany("synthetic-user", "synthetic-org", { name: company.name, cvr: company.cvr })
    vi.useFakeTimers()
    render(<I18nProvider locale="en-US"><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" client={client} onComplete={() => {}} /></I18nProvider>)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(client.get).toHaveBeenCalledOnce()
    expect(client.search).not.toHaveBeenCalled()
    await act(async () => { finish(success ? company : null) })
    expect(readSelectedCompany("synthetic-user", "synthetic-org")?.cvr ?? null).toBe(success ? null : company.cvr)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    if (success) {
      expect(screen.getByDisplayValue(company.name)).toBeTruthy()
      expect(client.search).not.toHaveBeenCalled()
    } else {
      expect(client.search).toHaveBeenCalledWith(company.cvr, expect.any(AbortSignal))
    }
  })
})

describe("production v2 seller confirmation", () => {
  it.each([true, false])("offers only supported registration choices when nonVAT is %s", async nonVatEnabled => {
    render(<I18nProvider locale="en-US"><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" confirmationEnabled nonVatEnabled={nonVatEnabled} client={createOnboardingV2Client(false, true)} onComplete={() => {}} /></I18nProvider>)
    fireEvent.click(screen.getByRole("button", { name: "Set up manually instead" }))
    expect(screen.getAllByRole("radio")).toHaveLength(nonVatEnabled ? 2 : 1)
    expect(screen.queryByRole("radio", { name: "I'm not VAT-registered" }) !== null).toBe(nonVatEnabled)
    fireEvent.submit(screen.getByRole("button", { name: "Create company" }).closest("form")!)
    expect(api.prepare).not.toHaveBeenCalled()
    expect(api.confirm).not.toHaveBeenCalled()
  })

  it("keeps default-off non-registration out of the controls while allowing registered preparation", async () => {
    const done = vi.fn()
    render(<I18nProvider locale="en-US"><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" confirmationEnabled client={createOnboardingV2Client(false, true)} onComplete={done} /></I18nProvider>)
    fireEvent.click(screen.getByRole("button", { name: "Set up manually instead" }))
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic Seller" } })
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "Testvej 1" } })
    fireEvent.change(screen.getByLabelText("CVR number"), { target: { value: "24256790" } })
    expect(screen.queryByRole("radio", { name: "I'm not VAT-registered" })).toBeNull()
    const priceChoice = screen.getByRole("combobox", { name: "Prices include VAT" }) as HTMLSelectElement
    expect(Array.from(priceChoice.options).map(option => option.value)).toEqual(["false", "true"])
    fireEvent.click(screen.getByRole("radio", { name: "I'm VAT-registered" }))
    fireEvent.click(screen.getByRole("button", { name: "Create company" }))
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(api.prepare).toHaveBeenCalledOnce()
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: true }))
  })
  it.each([true, false])("shows a CVR validation error for hosted manual registration %s before preparation", async registered => {
    const done = vi.fn()
    render(<I18nProvider locale="en-US"><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" confirmationEnabled nonVatEnabled client={createOnboardingV2Client(false, true)} onComplete={done} /></I18nProvider>)
    fireEvent.click(screen.getByRole("button", { name: "Set up manually instead" }))
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic Seller" } })
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "Testvej 1" } })
    fireEvent.click(screen.getAllByRole("radio")[registered ? 0 : 1]!)
    expect((screen.getByLabelText("CVR number") as HTMLInputElement).required).toBe(true)
    fireEvent.submit(screen.getByRole("button", { name: "Create company" }).closest("form")!)
    await screen.findByText("1 thing to fix before you can continue")
    expect(screen.getByLabelText("CVR number").getAttribute("aria-invalid")).toBe("true")
    expect(document.activeElement).toBe(document.querySelector("[role=alert][tabindex]"))
    expect(api.prepare).not.toHaveBeenCalled()
    expect(api.confirm).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
  })
  it.each(["", "   ", "12345678"])("rejects unsupported hosted manual CVR %j in the transport before preparation", async cvr => {
    const draft = newDraft(null, "signup@example.test", false)
    Object.assign(draft.values, { companyName: "Synthetic Seller", companyAddress: "Testvej 1", momsRegistered: false, cvr })
    await expect(createOnboardingV2Client(false, true).confirm(confirmationPayload(draft))).rejects.toThrow()
    expect(api.prepare).not.toHaveBeenCalled()
    expect(api.confirm).not.toHaveBeenCalled()
  })
  it.each([true, false])("saves explicit registration %s and prepares the final edited identity", async registered => {
    const done = vi.fn()
    render(<I18nProvider locale="en-US"><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" confirmationEnabled nonVatEnabled client={createOnboardingV2Client(false, true)} onComplete={done} /></I18nProvider>)
    fireEvent.click(screen.getByRole("button", { name: "Set up manually instead" }))
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic Seller" } })
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "Testvej 1" } })
    fireEvent.change(screen.getByLabelText("CVR number"), { target: { value: "24256790" } })
    const radios = screen.getAllByRole("radio") as HTMLInputElement[]
    expect(radios.every(radio => !radio.checked)).toBe(true)
    const save = screen.getByRole("button", { name: "Create company" }) as HTMLButtonElement
    // Never a silently disabled button: submitting without a VAT answer shows and focuses it.
    expect(save.disabled).toBe(false)
    // A real click: native validation must not swallow the submit before the notice (QUI-56).
    expect(radios.some(radio => radio.required)).toBe(false)
    fireEvent.click(save)
    await screen.findByText("1 thing to fix before you can continue")
    expect(document.activeElement).toBe(document.querySelector("[role=alert][tabindex]"))
    expect(api.prepare).not.toHaveBeenCalled()
    fireEvent.click(radios[0]!)
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Edited Seller" } })
    expect(radios[0]!.checked).toBe(true)
    // Noah's prod order (QUI-56): VAT first, then an invalid and a corrected CVR keeps the answer.
    fireEvent.change(screen.getByLabelText("CVR number"), { target: { value: "12345678" } })
    fireEvent.change(screen.getByLabelText("CVR number"), { target: { value: "24256790" } })
    expect(radios[0]!.checked).toBe(true)
    expect(save.disabled).toBe(false)
    fireEvent.click(radios[registered ? 0 : 1]!)
    fireEvent.click(save)
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(api.prepare).toHaveBeenCalledWith({ companyName: "Edited Seller", companyAddress: "Testvej 1", cvr: "24256790", vatId: registered ? "DK24256790" : undefined, countryCode: "DK" })
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ companyName: "Edited Seller", momsRegistered: registered, sellerVatConfirmationToken: "signed-final-identity", settings: expect.objectContaining({ taxRate: registered ? 25 : 0 }) }))
  })
  it.each([true, false])("keeps the moms choice %s across edits and a reload (QUI-56)", async registered => {
    const props = { userId: "synthetic-user", organizationId: "synthetic-org", signupEmail: "signup@example.test", confirmationEnabled: true, nonVatEnabled: true, client: createOnboardingV2Client(false, true), onComplete: vi.fn() }
    const view = render(<I18nProvider locale="en-US"><OnboardingV2 {...props} /></I18nProvider>)
    fireEvent.click(screen.getByRole("button", { name: "Set up manually instead" }))
    fireEvent.change(screen.getByLabelText("CVR number"), { target: { value: "24256790" } })
    fireEvent.click(screen.getAllByRole("radio")[registered ? 0 : 1]!)
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic Seller" } })
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "Testvej 1" } })
    fireEvent.change(screen.getByLabelText("Company type"), { target: { value: "IVS" } })
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "40486480" } })
    fireEvent.change(screen.getByRole("combobox", { name: "Currency" }), { target: { value: "EUR" } })
    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "en-GB" } })
    const checked = () => (screen.getAllByRole("radio") as HTMLInputElement[]).map(radio => radio.checked)
    expect(checked()).toEqual(registered ? [true, false] : [false, true])
    view.unmount()
    render(<I18nProvider locale="en-US"><OnboardingV2 {...props} /></I18nProvider>)
    await screen.findByLabelText("Name")
    expect(checked()).toEqual(registered ? [true, false] : [false, true])
    fireEvent.click(screen.getByRole("button", { name: "Create company" }))
    await waitFor(() => expect(props.onComplete).toHaveBeenCalledOnce())
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: registered, companyPhone: "40486480", settings: expect.objectContaining({ defaultCurrency: "EUR", locale: "en-GB" }) }))
  })
  it("names languages and currencies instead of showing codes (QUI-56)", () => {
    render(<I18nProvider locale="da-DK"><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" client={createOnboardingV2Client(false)} onComplete={() => {}} /></I18nProvider>)
    fireEvent.click(screen.getByRole("button", { name: /manuelt/i }))
    const labels = (name: string) => Array.from((screen.getByRole("combobox", { name }) as HTMLSelectElement).options).map(option => option.text)
    expect(labels("Valuta")).toEqual(["Danske kroner", "Euro", "Amerikanske dollars", "Britiske pund"])
    expect(labels("Sprog")).toEqual(["Dansk", "Engelsk"])
  })
  it("keeps the disabled extension's existing transport without preparing evidence", async () => {
    const draft = newDraft(null, "signup@example.test", false)
    Object.assign(draft.values, { companyName: "Synthetic Seller", companyAddress: "Testvej 1", momsRegistered: false })
    await createOnboardingV2Client(false).confirm(confirmationPayload(draft))
    expect(api.prepare).not.toHaveBeenCalled()
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: false }))
    expect(api.confirm.mock.calls[0]?.[0]).not.toHaveProperty("sellerVatConfirmationToken")
  })
})

describe("CVR VAT notice", () => {
  it.each(["da-DK", "en-US"])("explains contact replacement only for CVR review in %s", async locale => {
    const draft = newDraft({ cvr: "24256790", name: "Test", address: "Testvej 1", companyForm: "ApS", status: "active", statusClass: "active", momsRegistered: true }, "signup@example.test", false)
    storeDraft(draftKey("synthetic-user", "synthetic-org"), draft)
    render(<I18nProvider locale={locale}><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" client={createOnboardingV2Client(false)} onComplete={() => {}} /></I18nProvider>)
    expect((await screen.findByRole("note")).textContent).toBe(translate("onboardingV2.review.contacts", locale, { email: "signup@example.test" }))
    fireEvent.click(screen.getByRole("button", { name: translate("onboardingV2.cancel", locale) }))
    fireEvent.click(screen.getByRole("button", { name: translate("onboardingV2.search.manual", locale) }))
    expect(screen.queryByRole("note")).toBeNull()
  })
  const company = { cvr: "24256790", name: "Synthetic Studio ApS", address: "Testvej 1", companyForm: "ApS", status: "active", statusClass: "active" } as const
  const notice = /According to CVR, the company isn't VAT registered/
  it.each([[false, true], [null, false]] as const)("registry VAT %s with the user choosing not registered shows the CVR notice: %s", async (fact, shown) => {
    const draft = newDraft({ ...company, momsRegistered: fact }, "signup@example.test", false)
    draft.values.momsRegistered = false
    storeDraft(draftKey("synthetic-user", "synthetic-org"), draft)
    render(<I18nProvider locale="en-US"><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" nonVatEnabled client={createOnboardingV2Client(false)} onComplete={() => {}} /></I18nProvider>)
    await screen.findByLabelText("Name")
    expect(screen.queryByText(notice) !== null).toBe(shown)
  })
})

describe("unanswered CVR VAT validation (QUI-56)", () => {
  const cases = ["en-US", "da-DK"].flatMap(locale =>
    [true, false].flatMap(confirmationEnabled =>
      [true, false].flatMap(nonVatEnabled =>
        [true, false, null].map(momsRegistered => ({ locale, confirmationEnabled, nonVatEnabled, momsRegistered })),
      ),
    ),
  )

  it.each(cases)("handles CVR VAT $momsRegistered in $locale with confirmation=$confirmationEnabled, nonVAT=$nonVatEnabled", async ({ locale, confirmationEnabled, nonVatEnabled, momsRegistered }) => {
    const draft = newDraft({ cvr: "24256790", name: "Synthetic Studio ApS", address: "Testvej 1", companyForm: "ApS", status: "active", statusClass: "active", momsRegistered }, "signup@example.test", false)
    storeDraft(draftKey("synthetic-user", "synthetic-org"), draft)
    const done = vi.fn()
    render(<I18nProvider locale={locale}><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" confirmationEnabled={confirmationEnabled} nonVatEnabled={nonVatEnabled} client={createOnboardingV2Client(false, confirmationEnabled)} onComplete={done} /></I18nProvider>)
    const copy = locale === "da-DK" ? {
      save: "Bekræft og opret", vat: "Momsregistreret?",
      banner: "1 ting mangler, før du kan fortsætte",
      required: "Bekræft, om du er momsregistreret.",
    } : {
      save: "Confirm and create", vat: "VAT registered?",
      banner: "1 thing to fix before you can continue",
      required: "Confirm whether you're VAT-registered.",
    }
    const save = await screen.findByRole("button", { name: copy.save })
    const vat = confirmationEnabled ? screen.getAllByRole("radio")[0]! : screen.getByRole("combobox", { name: copy.vat })
    const unanswered = confirmationEnabled || momsRegistered === null || (!nonVatEnabled && !momsRegistered)
    if (!confirmationEnabled) expect((vat as HTMLSelectElement).value).toBe(unanswered ? "" : String(momsRegistered))
    if (confirmationEnabled) expect((vat as HTMLInputElement).checked).toBe(false)
    fireEvent.click(save)

    if (unanswered) {
      expect(await screen.findByText(copy.banner)).toBeTruthy()
      const error = screen.getByText(copy.required)
      expect(error.closest(".ob-card")?.contains(vat)).toBe(true)
      expect(vat.getAttribute("aria-invalid")).toBe("true")
      for (const control of confirmationEnabled ? screen.getAllByRole("radio") : [vat]) {
        expect(control.getAttribute("aria-describedby")).toBe(error.id)
      }
      expect(document.activeElement).toBe(document.querySelector("[role=alert][tabindex]"))
      expect(api.prepare).not.toHaveBeenCalled()
      expect(api.confirm).not.toHaveBeenCalled()
      expect(done).not.toHaveBeenCalled()
    } else {
      // Self-hosted setup can use a known registry value without hosted confirmation.
      await waitFor(() => expect(done).toHaveBeenCalledOnce())
      expect(api.prepare).not.toHaveBeenCalled()
      expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered }))
      return
    }

    // Answering the question clears the error and permits a retry in every capability state.
    if (confirmationEnabled) fireEvent.click(vat)
    else fireEvent.change(vat, { target: { value: "true" } })
    expect(screen.queryByText(copy.required)).toBeNull()
    fireEvent.click(save)
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(api.prepare).toHaveBeenCalledTimes(confirmationEnabled ? 1 : 0)
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: true }))
  })

  it.each([true, false])("shows all review errors together with an unanswered VAT choice, confirmation=%s", async confirmationEnabled => {
    const draft = newDraft({ cvr: "24256790", name: "Synthetic Studio ApS", address: "Testvej 1", companyForm: "ApS", status: "active", statusClass: "active", momsRegistered: null }, "signup@example.test", false)
    Object.assign(draft.values, { cvr: "12345678", companyEmail: "bad-email", companyName: "", invoicePrefix: "!", bankRegNumber: "12" })
    storeDraft(draftKey("synthetic-user", "synthetic-org"), draft)
    render(<I18nProvider locale="da-DK"><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" confirmationEnabled={confirmationEnabled} nonVatEnabled client={createOnboardingV2Client(false, confirmationEnabled)} onComplete={() => {}} /></I18nProvider>)
    fireEvent.click(await screen.findByRole("button", { name: "Bekræft og opret" }))
    expect(screen.getByText("Bekræft, om du er momsregistreret.")).toBeTruthy()
    expect(screen.getByText("Et CVR-nummer har 8 cifre")).toBeTruthy()
    expect(screen.getByText("Indtast en gyldig e-mail, fx navn@firma.dk")).toBeTruthy()
    for (const name of ["Navn", "CVR-nummer", "Fakturaemail", "Fakturanummerpræfiks", "Reg.nr.", "Kontonr."]) {
      expect(screen.getByLabelText(name).getAttribute("aria-invalid")).toBe("true")
    }
    expect(document.activeElement).toBe(document.querySelector("[role=alert][tabindex]"))
    expect(api.prepare).not.toHaveBeenCalled()
    expect(api.confirm).not.toHaveBeenCalled()
  })
})

describe("review page CVR errors (QUI-39)", () => {
  async function review(locale: string, client = createOnboardingV2Client(false)) {
    const draft = newDraft(null, "signup@example.test", false)
    Object.assign(draft.values, { companyName: "Synthetic Seller", companyAddress: "Testvej 1", momsRegistered: true, cvr: "12345678" })
    storeDraft(draftKey("synthetic-user", "synthetic-org"), draft)
    render(<I18nProvider locale={locale}><OnboardingV2 userId="synthetic-user" organizationId="synthetic-org" signupEmail="signup@example.test" nonVatEnabled client={client} onComplete={() => {}} /></I18nProvider>)
    const cvr = await screen.findByLabelText(translate("onboardingV2.field.cvr", locale))
    return { cvr, form: cvr.closest("form")! }
  }

  it.each([["en-US", "A CVR number has 8 digits"], ["da-DK", "Et CVR-nummer har 8 cifre"]])("shows a visible, localized message next to an invalid CVR in %s", async (locale, message) => {
    const { cvr, form } = await review(locale)
    expect(form.noValidate).toBe(true)
    fireEvent.submit(form)
    const error = await screen.findByText(message)
    expect(cvr.getAttribute("aria-invalid")).toBe("true")
    expect(cvr.getAttribute("aria-describedby")).toBe(error.id)
    expect(document.activeElement).toBe(document.querySelector("[role=alert][tabindex]"))
    fireEvent.click(screen.getByRole("link", { name: `${cvr.getAttribute("aria-label")}: ${message}` }))
    expect(document.activeElement).toBe(cvr)
    expect(api.confirm).not.toHaveBeenCalled()
    fireEvent.change(cvr, { target: { value: "24256790" } })
    expect(screen.queryByText(message)).toBeNull()
  })

  it("requires the company email even though the form opts out of native validation", async () => {
    const { cvr, form } = await review("da-DK")
    fireEvent.change(cvr, { target: { value: "24256790" } })
    const email = screen.getByLabelText(translate("onboardingV2.field.email", "da-DK"))
    fireEvent.change(email, { target: { value: "" } })
    fireEvent.submit(form)
    expect(await screen.findByText("Indtast en e-mail")).toBeTruthy()
    expect(email.getAttribute("aria-invalid")).toBe("true")
    expect(api.confirm).not.toHaveBeenCalled()
  })

  it.each(["cvr.invalid", "cvr.inactive", "cvr.unavailable", "cvr.alreadyRegistered"] as const)("shows the localized server rejection %s at the CVR field", async reason => {
    const client = { ...createOnboardingV2Client(false), confirm: vi.fn(async () => { throw new Error(reason) }) }
    const { cvr, form } = await review("da-DK", client)
    fireEvent.change(cvr, { target: { value: "24256790" } })
    fireEvent.submit(form)
    expect(await screen.findByText(translate(reason === "cvr.invalid" ? "validation.cvr.invalid" : reason, "da-DK"))).toBeTruthy()
    expect(client.confirm).toHaveBeenCalledOnce()
    expect(cvr.getAttribute("aria-invalid")).toBe("true")
    expect(screen.queryByText(translate("onboardingV2.saveFailed.title", "da-DK"))).toBeNull()
  })
})
