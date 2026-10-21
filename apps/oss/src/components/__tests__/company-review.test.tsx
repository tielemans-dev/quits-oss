// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CompanyReview } from "../onboarding/company-review"
import { I18nProvider } from "../../lib/i18n/react"
import { requiredLabel } from "../../test-utils/required-label"
const api = vi.hoisted(() => ({ prepare: vi.fn(async () => ({ token: "signed" })), confirm: vi.fn(async () => ({ status: "complete" })) }))
vi.mock("../../trpc/client", () => ({ trpc: { runtime: { prepareSellerVatConfirmation: { mutate: api.prepare } }, onboarding: { confirmV2: { mutate: api.confirm } } } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const company = { companyName: "Synthetic Seller", companyAddress: "Testvej 1", cvr: "24256790", companyForm: "ApS" }
describe("onboarding company review after lookup", () => {
  it.each([true, false])("honors the non-VAT capability %s before preparation", async nonVatEnabled => {
    const { container } = render(<I18nProvider locale="en-US"><CompanyReview company={company} confirmationEnabled nonVatEnabled={nonVatEnabled} onComplete={() => {}} /></I18nProvider>)
    expect(screen.getAllByRole("radio")).toHaveLength(nonVatEnabled ? 2 : 1)
    fireEvent.submit(container.querySelector("form")!)
    await screen.findByRole("alert")
    expect(api.prepare).not.toHaveBeenCalled()
    expect(api.confirm).not.toHaveBeenCalled()
  })

  it("marks every field required and keeps the registry address on two lines", () => {
    render(<I18nProvider locale="en-US"><CompanyReview company={{ ...company, companyAddress: "Testvej 12A, 1. tv.\n9000 Aalborg" }} confirmationEnabled onComplete={() => {}} /></I18nProvider>)
    expect((screen.getByLabelText(requiredLabel("Company address")) as HTMLTextAreaElement).value).toBe("Testvej 12A, 1. tv.\n9000 Aalborg")
    for (const name of ["Company name", "CVR", "Company form"]) expect(screen.getByLabelText(requiredLabel(name))).toBeTruthy()
    // The marker is visual only: the accessible name stays the plain label.
    expect(screen.getByRole("textbox", { name: "Company address" })).toBeTruthy()
  })

  it("has no hosted confirmation flow with the flag off", () => {
    render(<I18nProvider locale="en-US"><CompanyReview company={company} confirmationEnabled={false} onComplete={() => {}} /></I18nProvider>)
    expect(screen.queryByRole("radio")).toBeNull()
  })
  it.each([undefined, "", "   ", "12345678"])("rejects missing or invalid CVR %s for either VAT choice", async cvr => {
    const done = vi.fn()
    const { container } = render(<I18nProvider locale="en-US"><CompanyReview company={{ ...company, cvr }} confirmationEnabled nonVatEnabled onComplete={done} /></I18nProvider>)
    for (const radio of screen.getAllByRole("radio")) {
      fireEvent.click(radio)
      // Bypass HTML required validation to exercise the submission boundary itself.
      fireEvent.submit(container.querySelector("form")!)
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Enter a valid CVR number."))
      expect(api.prepare).not.toHaveBeenCalled()
      expect(api.confirm).not.toHaveBeenCalled()
      expect(done).not.toHaveBeenCalled()
    }
  })
  it("rejects the empty CVR in the manual fallback before requesting confirmation", async () => {
    const { container } = render(<I18nProvider locale="en-US"><CompanyReview confirmationEnabled nonVatEnabled onComplete={() => {}} /></I18nProvider>)
    fireEvent.click(screen.getAllByRole("radio")[1]!)
    fireEvent.submit(container.querySelector("form")!)
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Enter a valid CVR number."))
    expect(api.prepare).not.toHaveBeenCalled()
    expect(api.confirm).not.toHaveBeenCalled()
  })
  it("invalidates the VAT choice when the reviewed identity changes", () => {
    render(<I18nProvider locale="en-US"><CompanyReview company={company} confirmationEnabled nonVatEnabled onComplete={() => {}} /></I18nProvider>)
    fireEvent.click(screen.getAllByRole("radio")[0]!)
    fireEvent.change(screen.getByLabelText(requiredLabel("CVR")), { target: { value: "" } })
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByRole("radio").every(radio => !(radio as HTMLInputElement).checked)).toBe(true)
  })
  it.each([true, false])("requires an explicit choice %s after CVR and saves it through the extension", async registered => {
    const done = vi.fn()
    render(<I18nProvider locale="en-US"><CompanyReview company={company} confirmationEnabled nonVatEnabled onComplete={done} /></I18nProvider>)
    const radios = screen.getAllByRole("radio") as HTMLInputElement[]
    expect(radios.every(radio => !radio.checked && radio.required)).toBe(true)
    expect(screen.getByLabelText(requiredLabel("CVR"))).toBeTruthy()
    fireEvent.click(radios[registered ? 0 : 1]!)
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }))
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(api.prepare).toHaveBeenCalledWith({ companyName: company.companyName, companyAddress: company.companyAddress, cvr: company.cvr, vatId: registered ? "DK24256790" : undefined, countryCode: "DK" })
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ momsRegistered: registered, sellerVatConfirmationToken: "signed", source: "cvr", ...(registered ? { vatId: "DK24256790" } : {}) }))
  })
})
