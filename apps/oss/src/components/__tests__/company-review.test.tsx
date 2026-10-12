// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CompanyReview } from "../onboarding/company-review"
import { I18nProvider } from "../../lib/i18n/react"
const api = vi.hoisted(() => ({ prepare: vi.fn(async () => ({ token: "signed" })), confirm: vi.fn(async () => ({ status: "complete" })) }))
vi.mock("../../trpc/client", () => ({ trpc: { runtime: { prepareSellerVatConfirmation: { mutate: api.prepare } }, onboarding: { confirmV2: { mutate: api.confirm } } } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const company = { companyName: "Synthetic Seller", companyAddress: "Testvej 1", cvr: "24256790", companyForm: "ApS" }
describe("onboarding company review after lookup", () => {
  it("has no hosted confirmation flow with the flag off", () => {
    render(<I18nProvider locale="en-US"><CompanyReview company={company} confirmationEnabled={false} onComplete={() => {}} /></I18nProvider>)
    expect(screen.queryByRole("radio")).toBeNull()
  })
  it.each([true, false])("requires an explicit choice %s after CVR and saves it through the extension", async registered => {
    const done = vi.fn()
    render(<I18nProvider locale="en-US"><CompanyReview company={company} confirmationEnabled onComplete={done} /></I18nProvider>)
    const radios = screen.getAllByRole("radio") as HTMLInputElement[]
    expect(radios.every(radio => !radio.checked && radio.required)).toBe(true)
    expect(screen.getByLabelText("CVR")).toBeTruthy()
    fireEvent.click(radios[registered ? 0 : 1]!)
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }))
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(api.prepare).toHaveBeenCalledWith({ companyName: company.companyName, companyAddress: company.companyAddress, cvr: company.cvr, countryCode: "DK" })
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: registered, sellerVatConfirmationToken: "signed", source: "cvr", ...(registered ? { vatId: "DK24256790" } : {}) }))
  })
})
