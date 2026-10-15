// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"
import { OnboardingV2 } from "../onboarding-v2/onboarding-v2"
import { createOnboardingV2Client } from "../onboarding-v2/client"
import { confirmationPayload, draftKey, newDraft, storeDraft } from "../onboarding-v2/draft"

const api = vi.hoisted(() => ({ prepare: vi.fn(async () => ({ token: "signed-final-identity" })), confirm: vi.fn(async (_input: unknown) => ({ status: "complete" as const })) }))
vi.mock("../../trpc/client", () => ({ trpc: {
  runtime: { prepareSellerVatConfirmation: { mutate: api.prepare } },
  onboarding: { confirmV2: { mutate: api.confirm } },
} }))
afterEach(() => { cleanup(); sessionStorage.clear(); vi.clearAllMocks() })

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
    await screen.findByText("Check the highlighted fields before creating your company.")
    expect(screen.getByLabelText("CVR number").getAttribute("aria-invalid")).toBe("true")
    expect(document.activeElement).toBe(screen.getByLabelText("CVR number"))
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
    await screen.findByText("Check the highlighted fields before creating your company.")
    expect(document.activeElement).toBe(radios[0])
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
