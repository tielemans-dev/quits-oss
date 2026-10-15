// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"
import { translate } from "../../lib/i18n/translate"
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
    expect(save.disabled).toBe(true)
    fireEvent.click(radios[0]!)
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Edited Seller" } })
    expect(radios.every(radio => !radio.checked)).toBe(true)
    expect(save.disabled).toBe(true)
    fireEvent.click(radios[registered ? 0 : 1]!)
    fireEvent.click(save)
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(api.prepare).toHaveBeenCalledWith({ companyName: "Edited Seller", companyAddress: "Testvej 1", cvr: "24256790", vatId: registered ? "DK24256790" : undefined, countryCode: "DK" })
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ companyName: "Edited Seller", momsRegistered: registered, sellerVatConfirmationToken: "signed-final-identity", settings: expect.objectContaining({ taxRate: registered ? 25 : 0 }) }))
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
    expect(document.activeElement).toBe(cvr)
    expect(api.confirm).not.toHaveBeenCalled()
    fireEvent.change(cvr, { target: { value: "24256790" } })
    expect(screen.queryByText(message)).toBeNull()
  })

  it("points a server-side CVR rejection at the CVR field instead of failing silently or generically", async () => {
    const client = { ...createOnboardingV2Client(false), confirm: vi.fn(async () => { throw new Error(JSON.stringify([{ code: "custom", path: ["cvr"], message: "cvr.invalid" }])) }) }
    const { cvr, form } = await review("da-DK", client)
    fireEvent.change(cvr, { target: { value: "24256790" } })
    fireEvent.submit(form)
    expect(await screen.findByText("Et CVR-nummer har 8 cifre")).toBeTruthy()
    expect(client.confirm).toHaveBeenCalledOnce()
    expect(cvr.getAttribute("aria-invalid")).toBe("true")
    expect(screen.queryByText(translate("onboardingV2.saveFailed.title", "da-DK"))).toBeNull()
  })
})
