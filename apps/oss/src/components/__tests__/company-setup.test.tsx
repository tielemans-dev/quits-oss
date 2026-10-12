// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CompanySetup } from "../onboarding/company-setup"
import { I18nProvider } from "../../lib/i18n/react"
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
    render(<I18nProvider locale="en-US"><CompanySetup onComplete={done} /></I18nProvider>)
    await search(); fireEvent.click(await screen.findByRole("button", { name: "Review company" }))
    expect((screen.getByLabelText("CVR") as HTMLInputElement).value).toBe(facts.cvr)
    const radios = screen.getAllByRole("radio") as HTMLInputElement[]
    expect(radios.every(radio => !radio.checked)).toBe(true)
    fireEvent.click(radios[0]!)
    fireEvent.change(screen.getByLabelText("Company Name"), { target: { value: "Edited Seller" } })
    expect(radios.every(radio => !radio.checked)).toBe(true)
    fireEvent.click(radios[registered ? 0 : 1]!)
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }))
    await waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(api.prepare).toHaveBeenCalledWith(expect.objectContaining({ companyName: "Edited Seller", cvr: facts.cvr }))
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ source: "cvr", companyName: "Edited Seller", momsRegistered: registered }))
  })
  it("shows unknown legal facts without automatic presets and keeps manual review available", async () => {
    api.lookup.mockResolvedValue({ companies: [{ ...facts, statusText: "UKENDT", presetsAllowed: false }], unavailable: false })
    render(<I18nProvider locale="en-US"><CompanySetup onComplete={() => {}} /></I18nProvider>)
    await search(); await screen.findByText("ApS · UKENDT")
    expect(screen.queryByRole("button", { name: "Review company" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Enter company manually" }))
    expect((screen.getByLabelText("CVR") as HTMLInputElement).value).toBe("")
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
    expect(screen.getByLabelText("CVR")).toBeTruthy()
  })
})
