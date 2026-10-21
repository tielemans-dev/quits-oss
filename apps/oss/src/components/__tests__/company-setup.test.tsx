// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CompanySetup } from "../onboarding/company-setup"
import { I18nProvider } from "../../lib/i18n/react"
import { requiredLabel } from "../../test-utils/required-label"
const api = vi.hoisted(() => ({ lookup: vi.fn(), prepare: vi.fn(async () => ({ token: "signed" })), confirm: vi.fn(async () => ({ status: "complete" })) }))
vi.mock("../../trpc/client", () => ({ trpc: { runtime: { lookupOnboardingCompany: { mutate: api.lookup }, prepareSellerVatConfirmation: { mutate: api.prepare } }, onboarding: { confirmV2: { mutate: api.confirm } } } }))
const facts = { cvr: "24256790", companyName: "Synthetic Seller", companyAddress: "Testvej 1", companyForm: "ApS", statusText: "NORMAL", presetsAllowed: true }
afterEach(() => { cleanup(); vi.clearAllMocks() })
async function search() {
  fireEvent.change(screen.getByLabelText("Company name or CVR"), { target: { value: "Synthetic" } })
  fireEvent.click(screen.getByRole("button", { name: "Find company" }))
}
describe("lookup to existing onboarding review", () => {
  it.each([true, false])("hands selected facts to review with explicit VAT choice %s and final edited identity", async registered => {
    api.lookup.mockResolvedValue({ companies: [facts], unavailable: false })
    const done = vi.fn()
    render(<I18nProvider locale="en-US"><CompanySetup nonVatEnabled onComplete={done} /></I18nProvider>)
    await search(); fireEvent.click(await screen.findByRole("button", { name: "Review company" }))
    expect((screen.getByLabelText(requiredLabel("CVR")) as HTMLInputElement).value).toBe(facts.cvr)
    const radios = screen.getAllByRole("radio") as HTMLInputElement[]
    expect(radios.every(radio => !radio.checked)).toBe(true)
    expect(radios).toHaveLength(2)
    fireEvent.click(screen.getByRole("radio", { name: "I'm VAT-registered" }))
    fireEvent.change(screen.getByLabelText(requiredLabel("Company name")), { target: { value: "Edited Seller" } })
    expect(radios.every(radio => !radio.checked)).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: registered ? "I'm VAT-registered" : "I'm not VAT-registered" }))
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }))
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(api.prepare).toHaveBeenCalledWith(expect.objectContaining({ companyName: "Edited Seller", cvr: facts.cvr }))
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ source: "cvr", companyName: "Edited Seller", momsRegistered: registered }))
  })
  it.each([undefined, false])("hides unsupported non-VAT choice with capability %s after lookup", async nonVatEnabled => {
    api.lookup.mockResolvedValue({ companies: [facts], unavailable: false })
    const done = vi.fn()
    render(<I18nProvider locale="en-US"><CompanySetup nonVatEnabled={nonVatEnabled} onComplete={done} /></I18nProvider>)
    await search(); fireEvent.click(await screen.findByRole("button", { name: "Review company" }))
    expect(screen.getAllByRole("radio")).toHaveLength(1)
    expect(screen.queryByRole("radio", { name: "I'm not VAT-registered" })).toBeNull()
    const registered = screen.getByRole("radio", { name: "I'm VAT-registered" }) as HTMLInputElement
    expect(registered.checked).toBe(false)
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true)
    expect(api.prepare).not.toHaveBeenCalled()
    expect(api.confirm).not.toHaveBeenCalled()
    fireEvent.click(registered)
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }))
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(api.prepare).toHaveBeenCalledWith(expect.objectContaining({ companyName: facts.companyName, cvr: facts.cvr }))
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ source: "cvr", momsRegistered: true }))
  })
  it("shows unknown legal facts without automatic presets and keeps manual review available", async () => {
    api.lookup.mockResolvedValue({ companies: [{ ...facts, statusText: "UKENDT", presetsAllowed: false }], unavailable: false })
    render(<I18nProvider locale="en-US"><CompanySetup onComplete={() => {}} /></I18nProvider>)
    await search(); await screen.findByText("ApS · UKENDT")
    expect(screen.queryByRole("button", { name: "Review company" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Enter company manually" }))
    expect((screen.getByLabelText(requiredLabel("CVR")) as HTMLInputElement).value).toBe("")
    expect(screen.getAllByRole("radio").every(radio => !(radio as HTMLInputElement).checked)).toBe(true)
  })
  it("ignores stale lookup results after editing the query and offers manual fallback on failure", async () => {
    let resolve!: (value: unknown) => void
    api.lookup.mockReturnValueOnce(new Promise(done => { resolve = done }))
    render(<I18nProvider locale="en-US"><CompanySetup onComplete={() => {}} /></I18nProvider>)
    await search()
    fireEvent.change(screen.getByLabelText("Company name or CVR"), { target: { value: "Other" } })
    resolve({ companies: [facts], unavailable: false })
    await waitFor(() => expect(screen.queryByText("Synthetic Seller · 24256790")).toBeNull())
    api.lookup.mockRejectedValueOnce(new Error("timeout"))
    fireEvent.click(screen.getByRole("button", { name: "Find company" }))
    await screen.findByRole("status")
    fireEvent.click(screen.getByRole("button", { name: "Enter company manually" }))
    expect(screen.getByLabelText(requiredLabel("CVR"))).toBeTruthy()
  })
})
