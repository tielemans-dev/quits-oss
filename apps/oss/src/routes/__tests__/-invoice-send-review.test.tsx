// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const aiFixture = vi.hoisted(() => ({ enabled: false }))
const api = vi.hoisted(() => ({ bankReadiness: vi.fn(), readiness: vi.fn(), create: vi.fn(), update: vi.fn(), send: vi.fn(), resend: vi.fn(), settings: vi.fn(), contacts: vi.fn(), navigate: vi.fn(), generate: vi.fn(), get: vi.fn(), currency: "DKK" }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options, useParams: () => ({ invoiceId: "synthetic-invoice" }), useSearch: () => ({}) }),
  Link: ({ children, to, onClick }: { children: ReactNode; to: string; onClick?: () => void }) => <a href={to} onClick={event => { event.preventDefault(); onClick?.(); api.navigate({ to }) }}>{children}</a>,
  useNavigate: () => api.navigate,
}))
vi.mock("../../trpc/client", () => ({ trpc: {
  invoices: { sendReadiness: { query: api.readiness }, get: { query: api.get }, createV2: { mutate: api.create }, updateV2: { mutate: api.update }, send: { mutate: api.send }, resendEmail: { mutate: api.resend } },
  paymentDetails: { firstSendReadiness: { query: api.bankReadiness } },
  contacts: { list: { query: api.contacts } }, catalog: { list: { query: async () => [] } },
  ai: { generateInvoiceDraft: { mutate: api.generate } },
  runtime: { capabilities: { query: async () => ({ aiInvoiceDraft: { enabled: aiFixture.enabled, byok: aiFixture.enabled } }) } }, settings: { get: { query: api.settings } },
} }))
vi.mock("../../hooks/use-org-currency", () => ({ useOrgCurrency: () => api.currency }))
vi.mock("../../lib/auth-client", () => ({ useSession: () => ({ data: { session: { activeOrganizationId: "synthetic-org" } }, isPending: false }) }))
vi.mock("../../components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: ReactNode }) => <select value={value ?? ""} onChange={event => onValueChange(event.target.value)}><option value="" />{children}</select>,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
  SelectTrigger: () => null, SelectValue: () => null,
}))
vi.mock("../../components/localized-date-field", () => ({ LocalizedDateField: ({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) => <input id={id} type="date" value={value} onChange={event => onChange(event.target.value)} /> }))
vi.mock("../../lib/i18n/react", () => {
  const i18n = { locale: "en-US", t: (key: string) => key }
  return { useI18n: () => i18n }
})
import { initializeRequestOrganizationId, resetRequestOrganizationForTesting } from "../../lib/active-organization"
vi.mock("../../components/billing/trial-access", () => ({ useTrialAccess: () => null, isReadOnly: () => false, PaywallBlock: () => null }))
vi.mock("../../components/invoices/panels", () => ({ InvoiceLifecyclePanels: () => null }))
import { Route as DetailRoute } from "../_app/invoices/$invoiceId"
const DetailPage = (DetailRoute as unknown as { component: ComponentType }).component
import { Route as NewRoute } from "../_app/invoices/new"
const NewPage = (NewRoute as unknown as { component: ComponentType }).component
const contact = { id: "synthetic-buyer", name: "Synthetic Buyer", email: "buyer@example.test", company: "Synthetic Buyer", address: null, city: null, state: null, zip: null, country: "DK" }
const invoice = { id: "synthetic-invoice" }
beforeEach(() => {
  sessionStorage.clear()
  api.currency = "DKK"
  api.get.mockResolvedValue({ id: invoice.id, number: null, status: "draft", paymentStatus: "unpaid", purpose: "sale", currency: "EUR", taxRegime: "eu_vat", dueDate: "2099-01-01", issueDate: "2026-10-13", supplyDate: "2026-10-05", items: [], total: 0, subtotal: 0, taxAmount: 0, contact, sellerSnapshot: { countryCode: "DK", momsRegistered: false } })
  resetRequestOrganizationForTesting()
  initializeRequestOrganizationId("synthetic-org")
  api.bankReadiness.mockResolvedValue({ bankMissing: false })
  aiFixture.enabled = false
  api.contacts.mockResolvedValue([contact])
  api.readiness.mockResolvedValue({ issues: [], taxRate: "25", pricesIncludeTax: false, baseCurrency: "DKK" })
  api.settings.mockResolvedValue({ locale: "en-US", timezone: "UTC", baseCurrency: "DKK", taxRate: 25, pricesIncludeTax: false, emailDelivery: { available: true }, companyName: "Synthetic Studio" })
  api.create.mockResolvedValue({ id: invoice.id })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

function fillDraft() {
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: contact.id } })
  fireEvent.change(document.getElementById("dueDate")!, { target: { value: "2099-01-01" } })
  fireEvent.change(screen.getByLabelText("docForm.column.description"), { target: { value: "Synthetic work" } })
}
describe("invoice review regressions", () => {
  it("opens a draft without a delivery date with an empty field", async () => {
    api.get.mockResolvedValue({ ...await api.get(), supplyDate: null })
    render(<DetailPage />)
    fireEvent.click(await screen.findByRole("button", { name: "invoices.detail.action.edit" }))
    expect((screen.getByLabelText("invoices.issuance.supplyDate") as HTMLInputElement).value).toBe("")
  })
  it.each(["2026-10-07", null])("saves the draft delivery date as %s", async (supplyDate) => {
    const stored = { ...await api.get(), currency: "DKK" }
    api.get.mockResolvedValue(stored)
    api.update.mockResolvedValue({ ...stored, supplyDate })
    render(<DetailPage />)
    fireEvent.click(await screen.findByRole("button", { name: "invoices.detail.action.edit" }))
    const field = screen.getByLabelText("invoices.issuance.supplyDate")
    expect((field as HTMLInputElement).value).toBe("2026-10-05")
    fireEvent.change(field, { target: { value: supplyDate ?? "" } })
    fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveChanges" }))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ id: invoice.id, supplyDate })))
    await screen.findByRole("button", { name: "invoices.detail.action.edit" })
    const sendSupplyDate = supplyDate ?? new Date().toISOString().slice(0, 10)
    expect((screen.getByLabelText("invoices.issuance.supplyDate") as HTMLInputElement).value).toBe(sendSupplyDate)
    api.send.mockResolvedValue({})
    api.get.mockResolvedValue({ ...stored, supplyDate })
    fireEvent.click(screen.getByRole("button", { name: "invoices.detail.action.send" }))
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ id: invoice.id, supplyDate: sendSupplyDate })))
    await waitFor(() => expect(screen.getByRole("button", { name: "invoices.detail.action.send" }).hasAttribute("disabled")).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "invoices.detail.action.edit" }))
    expect((screen.getByLabelText("invoices.issuance.supplyDate") as HTMLInputElement).value).toBe(supplyDate ?? "")
  })

  it.each(["2026-10-09", null])("keeps a delivery-date edit to %s made during an earlier save", async (supplyDate) => {
    const stored = await api.get()
    let finish!: (invoice: unknown) => void
    api.update.mockReturnValue(new Promise(resolve => { finish = resolve }))
    render(<DetailPage />)
    fireEvent.click(await screen.findByRole("button", { name: "invoices.detail.action.edit" }))
    const field = screen.getByLabelText("invoices.issuance.supplyDate") as HTMLInputElement
    fireEvent.change(field, { target: { value: "2026-10-07" } })
    fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveChanges" }))
    fireEvent.change(field, { target: { value: supplyDate ?? "" } })
    await act(async () => { finish({ ...stored, supplyDate: "2026-10-07" }) })
    expect(screen.getByLabelText("invoices.issuance.supplyDate")).toBe(field)
    expect(field.value).toBe(supplyDate ?? "")
    expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ supplyDate: "2026-10-07" }))
    api.update.mockResolvedValue({ ...stored, supplyDate })
    fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveChanges" }))
    await screen.findByRole("button", { name: "invoices.detail.action.edit" })
    expect(api.update).toHaveBeenLastCalledWith(expect.objectContaining({ supplyDate }))
  })

  it("rejects exponent quantities before saving and permits one comma-normalized retry", async () => {
    render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    const quantity = screen.getByLabelText("docForm.column.qty")
    fireEvent.change(quantity, { target: { value: "1e3" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveSend" })) })
    await screen.findByText("docForm.validation.quantityInvalid")
    expect(api.create).not.toHaveBeenCalled()
    expect(api.bankReadiness).not.toHaveBeenCalled()
    expect(api.send).not.toHaveBeenCalled()
    let persist!: (value: { id: string }) => void
    api.create.mockReturnValue(new Promise(resolve => { persist = resolve }))
    fireEvent.change(quantity, { target: { value: "1,5" } })
    const save = screen.getByRole("button", { name: "docForm.action.saveSend" })
    await act(async () => { fireEvent.click(save); fireEvent.click(save) })
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ quantity: "1.5" })] }))
    await act(async () => { persist(invoice) })
    expect(api.send).toHaveBeenCalledTimes(1)
  })
  it("persists the complete draft before bank Settings navigation without sending", async () => {
    let persist!: (value: { id: string }) => void
    api.create.mockReturnValue(new Promise(resolve => { persist = resolve }))
    api.bankReadiness.mockResolvedValue({ bankMissing: true })
    render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    fireEvent.change(screen.getByLabelText("docForm.column.qty"), { target: { value: "2" } })
    fireEvent.change(screen.getByLabelText("docForm.column.unitPrice"), { target: { value: "123.45" } })
    fireEvent.change(screen.getByLabelText("invoices.issuance.supplyDate"), { target: { value: "2026-10-05" } })
    fireEvent.change(screen.getByLabelText("vat.lineTreatment"), { target: { value: "exempt" } })
    fireEvent.change(screen.getByLabelText("vat.statement"), { target: { value: "Synthetic exemption evidence" } })
    fireEvent.change(screen.getByLabelText("docForm.notes"), { target: { value: "Keep these notes" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveSend" })) })
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.bankReadiness).not.toHaveBeenCalled()
    expect(screen.queryByText("onboardingV2.bankNudge.settings")).toBeNull()
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "docForm.action.saving" })[1]) })
    expect(api.create).toHaveBeenCalledTimes(1)
    await act(async () => { persist({ id: invoice.id }) })
    const settings = await screen.findByText("onboardingV2.bankNudge.settings")
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.create).toHaveBeenCalledWith({ contactId: contact.id, dueDate: "2099-01-01", supplyDate: "2026-10-05", taxRate: "25", pricesIncludeTax: false, vatEvidence: { statementText: "Synthetic exemption evidence" }, notes: "Keep these notes", items: [{ description: "Synthetic work", quantity: "2", unitPrice: "123.45", vat: { treatment: "exempt", rate: "0", reasonCode: "financial", country: null } }] })
    await act(async () => { fireEvent.click(settings) })
    expect(api.send).not.toHaveBeenCalled()
    expect(api.resend).not.toHaveBeenCalled()
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ to: "/settings" }))
  })
  it("sends the saved draft once only after continuing the bank nudge", async () => {
    api.bankReadiness.mockResolvedValue({ bankMissing: true })
    api.send.mockResolvedValue({})
    render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveSend" })) })
    const proceed = await screen.findByRole("button", { name: "onboardingV2.bankNudge.continue" })
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.send).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(proceed) })
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.send).toHaveBeenCalledTimes(1)
    expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ id: invoice.id }))
    expect(api.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ to: "/invoices/$invoiceId" }))
  })
  it("keeps the form when persistence fails and never opens the bank nudge", async () => {
    api.bankReadiness.mockResolvedValue({ bankMissing: true })
    api.create.mockRejectedValue(new Error("Synthetic persistence failure"))
    render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveSend" })) })
    await screen.findByText("Synthetic persistence failure")
    expect(api.bankReadiness).not.toHaveBeenCalled()
    expect((screen.getByLabelText("docForm.column.description") as HTMLInputElement).value).toBe("Synthetic work")
    expect(api.navigate).not.toHaveBeenCalled()
    expect(api.send).not.toHaveBeenCalled()
    api.create.mockResolvedValue({ id: invoice.id })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveSend" })) })
    await screen.findByRole("dialog")
    expect(api.create).toHaveBeenCalledTimes(2)
    expect(api.send).not.toHaveBeenCalled()
  })
  it("keeps a single saved draft without sending when the bank nudge is cancelled", async () => {
    api.bankReadiness.mockResolvedValue({ bankMissing: true })
    render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveSend" })) })
    await screen.findByText("onboardingV2.bankNudge.settings")
    await act(async () => { fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }) })
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/invoices/$invoiceId", params: { invoiceId: invoice.id } })))
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.send).not.toHaveBeenCalled()
  })

  it("blocks draft saves until the organisation configuration has loaded, and when it fails to load", async () => {
    let resolve!: (value: unknown) => void
    api.readiness.mockReturnValue(new Promise(value => { resolve = value }))
    const view = render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    const save = screen.getByRole("button", { name: "docForm.action.saveDraft" }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await act(async () => { fireEvent.click(save) })
    expect(api.create).not.toHaveBeenCalled()
    await act(async () => { resolve({ issues: [], taxRate: "20", pricesIncludeTax: false, baseCurrency: "DKK" }) })
    expect((screen.getByRole("button", { name: "docForm.action.saveDraft" }) as HTMLButtonElement).disabled).toBe(false)
    view.unmount()
    api.readiness.mockReset().mockRejectedValue(new Error("Synthetic policy unavailable"))
    render(<NewPage />)
    await screen.findByText("invoiceValidation.unknown")
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    expect((screen.getByRole("button", { name: "docForm.action.saveDraft" }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveDraft" })) })
    expect(api.create).not.toHaveBeenCalled()
  })
  it("keeps hosted new prices exclusive after delayed settings and uses the policy VAT rate", async () => {
    let resolve!: (value: unknown) => void
    api.readiness.mockReturnValue(new Promise(value => { resolve = value }))
    render(<NewPage />)
    expect(screen.getByRole("radio", { name: "invoiceVat.pricesExclude" }).getAttribute("aria-checked")).toBe("true")
    await act(async () => { resolve({ issues: [], taxRate: "0", standardVatRate: "25", countryCode: "DK", pricesIncludeTax: true, baseCurrency: "DKK" }) })
    expect(screen.getByRole("radio", { name: "invoiceVat.pricesExclude" }).getAttribute("aria-checked")).toBe("true")
    expect(screen.getByText("invoiceVat.hosted")).toBeTruthy()
    fillDraft()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveDraft" })) })
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ pricesIncludeTax: false, taxRate: "25" }))
  })
  it.each([true, false])("combines restrictive defaults with explicit registration %s", async momsRegistered => {
    api.readiness.mockResolvedValue({ issues: [], taxRate: "25", standardVatRate: "25", momsRegistered, pricesIncludeTax: true, countryCode: "DK", baseCurrency: "DKK" })
    render(<NewPage />)
    await screen.findByText(momsRegistered ? "invoiceVat.hosted" : "line.noVat")
    expect(screen.getByRole("radio", { name: "invoiceVat.pricesExclude" }).getAttribute("aria-checked")).toBe("true")
    fillDraft()
    fireEvent.change(screen.getByLabelText("docForm.column.unitPrice"), { target: { value: "100" } })
    expect(screen.getByText("docForm.summary.total").parentElement?.textContent).toMatch(new RegExp(`DKK\\s*${momsRegistered ? 125 : 100}[.,]00`))
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveDraft" })) })
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ pricesIncludeTax: false, taxRate: momsRegistered ? "25" : "0", items: [expect.objectContaining({ vat: undefined })] }))
  })
  it("applies the mandatory policy VAT rate over an AI rate accepted before readiness arrived", async () => {
    aiFixture.enabled = true
    let resolve!: (value: unknown) => void
    api.readiness.mockReturnValue(new Promise(value => { resolve = value }))
    api.generate.mockResolvedValue({ draft: { taxRate: 0, items: [{ description: "Synthetic work", quantity: 1, unitPrice: 100 }] } })
    render(<NewPage />)
    const generate = await screen.findByRole("button", { name: "invoices.new.ai.action.generate" })
    await waitFor(() => expect((generate as HTMLButtonElement).disabled).toBe(false))
    fireEvent.change(screen.getByLabelText("invoices.new.ai.label"), { target: { value: "Synthetic work" } })
    await act(async () => { fireEvent.click(generate) })
    expect(api.generate).toHaveBeenCalledOnce()
    await act(async () => { resolve({ issues: [], taxRate: "25", standardVatRate: "25", momsRegistered: true, pricesIncludeTax: true, countryCode: "DK", baseCurrency: "DKK" }) })
    fillDraft()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveDraft" })) })
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ taxRate: "25", pricesIncludeTax: false }))
  })
  it("preserves a self-hosted inclusive default and its configured VAT rate", async () => {
    api.readiness.mockResolvedValue({ issues: [], taxRate: "20", pricesIncludeTax: true, countryCode: "SE", baseCurrency: "DKK" })
    render(<NewPage />)
    await waitFor(() => expect(screen.getByRole("radio", { name: "invoiceVat.pricesInclude" }).getAttribute("aria-checked")).toBe("true"))
    fillDraft()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveDraft" })) })
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ pricesIncludeTax: true, taxRate: "20" }))
  })
  it("defaults Danish invoices to standard VAT and restores 25 percent after outside VAT", async () => {
    api.readiness.mockResolvedValue({ issues: [], taxRate: "25", pricesIncludeTax: false, countryCode: "DK", baseCurrency: "DKK" })
    render(<NewPage />)
    await waitFor(() => expect(api.readiness).toHaveBeenCalled())
    const vat = await screen.findByLabelText("vat.lineTreatment") as HTMLSelectElement
    expect(vat.value).toBe("standard")
    fireEvent.change(vat, { target: { value: "out_of_scope" } })
    expect(vat.value).toBe("out_of_scope")
    fireEvent.change(vat, { target: { value: "standard" } })
    fillDraft()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveDraft" })) })
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ vat: expect.objectContaining({ treatment: "standard", rate: "0.25" }) })] }))
  })
  it("shows a policy-fixed rate as plain text on each line instead of a choice", async () => {
    api.readiness.mockResolvedValue({ issues: [], taxRate: "25", standardVatRate: "25", pricesIncludeTax: false, countryCode: "DK", baseCurrency: "DKK" })
    render(<NewPage />)
    await waitFor(() => expect(api.readiness).toHaveBeenCalled())
    expect(await screen.findByText("invoiceVat.hosted")).toBeTruthy()
    expect(screen.queryByLabelText("vat.lineTreatment")).toBeNull()
  })
  it.each([true, false])("preserves explicit pricesIncludeTax=%s while loading configured tax", async pricesIncludeTax => {
    let resolve!: (value: unknown) => void
    api.readiness.mockReturnValue(new Promise(value => { resolve = value }))
    render(<NewPage />)
    fireEvent.change(screen.getByLabelText("docForm.column.unitPrice"), { target: { value: "100" } })
    const choice = pricesIncludeTax ? "invoiceVat.pricesInclude" : "invoiceVat.pricesExclude"
    fireEvent.click(screen.getByRole("radio", { name: choice }))
    await act(async () => { resolve({ issues: [], taxRate: "20", standardVatRate: "20", pricesIncludeTax: !pricesIncludeTax, baseCurrency: "DKK" }) })
    expect(screen.getByRole("radio", { name: choice }).getAttribute("aria-checked")).toBe("true")
    fillDraft()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveDraft" })) })
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ pricesIncludeTax, taxRate: "20" }))
  })
  it("replaces an edited rate and non-compliant line VAT once a policy fixes the rate for the chosen customer", async () => {
    api.readiness.mockResolvedValueOnce({ issues: [], taxRate: "25", pricesIncludeTax: false, momsRegistered: true, countryCode: "DK", baseCurrency: "DKK" })
    api.readiness.mockResolvedValue({ issues: [], taxRate: "25", standardVatRate: "25", pricesIncludeTax: false, momsRegistered: true, countryCode: "DK", baseCurrency: "DKK" })
    render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fireEvent.change(await screen.findByLabelText("vat.lineTreatment"), { target: { value: "exempt" } })
    fireEvent.change(screen.getByLabelText("docForm.summary.tax"), { target: { value: "5" } })
    fillDraft()
    await screen.findByText("invoiceVat.hosted")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveDraft" })) })
    expect(api.readiness).toHaveBeenLastCalledWith({ contactId: contact.id, currency: "DKK" })
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ taxRate: "25", items: [expect.objectContaining({ vat: undefined })] }))
  })
})

// MOCK: transport and route context only; both forms, issuance fields and bank gate are real.
describe("foreign-currency issuance across the bank nudge", () => {
  it("continues from the new form once with the entered valuation and clears retained inputs", async () => {
    api.currency = "EUR"
    api.bankReadiness.mockResolvedValue({ bankMissing: true })
    api.send.mockResolvedValue({})
    render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    fireEvent.change(await screen.findByLabelText("invoices.issuance.rate"), { target: { value: "7.456789" } })
    fireEvent.change(screen.getByLabelText("invoices.issuance.rateDate"), { target: { value: "2026-10-02" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveSend" })) })
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "onboardingV2.bankNudge.continue" })) })
    expect(api.send).toHaveBeenCalledOnce()
    expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ id: invoice.id, exchangeRate: "7.456789", rateDate: "2026-10-02" }))
    expect(api.create).toHaveBeenCalledOnce()
    expect(sessionStorage.length).toBe(0)
  })
  it.each(["cancel", "settings", "failed send"])("preserves the entered valuation after %s and sends the same draft on retry", async outcome => {
    api.currency = "EUR"
    api.bankReadiness.mockResolvedValue({ bankMissing: true })
    api.send.mockResolvedValue({})
    const view = render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    fireEvent.change(await screen.findByLabelText("invoices.issuance.rate"), { target: { value: "7.456789" } })
    fireEvent.change(screen.getByLabelText("invoices.issuance.rateDate"), { target: { value: "2026-10-02" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveSend" })) })
    await screen.findByRole("dialog")
    if (outcome === "settings") {
      await act(async () => { fireEvent.click(screen.getByText("onboardingV2.bankNudge.settings")) })
      expect(api.navigate).toHaveBeenLastCalledWith({ to: "/settings" })
    } else if (outcome === "cancel") {
      await act(async () => { fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }) })
    } else {
      api.send.mockRejectedValueOnce(new Error("Synthetic send failure"))
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "onboardingV2.bankNudge.continue" })) })
      expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ exchangeRate: "7.456789", rateDate: "2026-10-02" }))
    }
    await waitFor(() => expect(api.navigate).toHaveBeenCalled())
    expect(api.create).toHaveBeenCalledOnce()
    if (outcome !== "failed send") expect(api.send).not.toHaveBeenCalled()
    view.unmount()
    api.bankReadiness.mockResolvedValue({ bankMissing: false })
    render(<DetailPage />)
    const rate = await screen.findByLabelText("invoices.issuance.rate") as HTMLInputElement
    expect(rate.value).toBe("7.456789")
    expect((screen.getByLabelText("invoices.issuance.rateDate") as HTMLInputElement).value).toBe("2026-10-02")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "invoices.detail.action.send" })) })
    expect(api.send).toHaveBeenLastCalledWith(expect.objectContaining({ id: invoice.id, exchangeRate: "7.456789", rateDate: "2026-10-02" }))
    expect(api.send).toHaveBeenCalledTimes(outcome === "failed send" ? 2 : 1)
    expect(api.create).toHaveBeenCalledOnce()
  })
})


describe("detail-page foreign-currency bank nudge", () => {
  it.each(["cancel", "settings", "failed send"])("retains edited valuation after %s and returning to the draft", async outcome => {
    api.bankReadiness.mockResolvedValue({ bankMissing: true })
    api.send.mockResolvedValue({})
    const view = render(<DetailPage />)
    fireEvent.change(await screen.findByLabelText("invoices.issuance.rate"), { target: { value: "7.123456" } })
    fireEvent.change(screen.getByLabelText("invoices.issuance.rateDate"), { target: { value: "2026-09-30" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "invoices.detail.action.send" })) })
    await screen.findByRole("dialog")
    if (outcome === "settings") {
      await act(async () => { fireEvent.click(screen.getByText("onboardingV2.bankNudge.settings")) })
    } else if (outcome === "cancel") {
      await act(async () => { fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }) })
    } else {
      api.send.mockRejectedValueOnce(new Error("Synthetic send failure"))
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "onboardingV2.bankNudge.continue" })) })
      await screen.findByText("Synthetic send failure")
    }
    if (outcome !== "failed send") expect(api.send).not.toHaveBeenCalled()
    view.unmount()
    api.bankReadiness.mockResolvedValue({ bankMissing: false })
    render(<DetailPage />)
    expect((await screen.findByLabelText("invoices.issuance.rate") as HTMLInputElement).value).toBe("7.123456")
    expect((screen.getByLabelText("invoices.issuance.rateDate") as HTMLInputElement).value).toBe("2026-09-30")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "invoices.detail.action.send" })) })
    expect(api.send).toHaveBeenLastCalledWith(expect.objectContaining({ id: invoice.id, exchangeRate: "7.123456", rateDate: "2026-09-30" }))
    expect(api.send).toHaveBeenCalledTimes(outcome === "failed send" ? 2 : 1)
    expect(api.create).not.toHaveBeenCalled()
    expect(sessionStorage.length).toBe(0)
  })
})

describe("VAT treatment choices on the draft editor", () => {
  it("keeps the full classification editor, rate input and group preview without a policy-fixed rate", async () => {
    api.readiness.mockResolvedValue({ issues: [], taxRate: "25", pricesIncludeTax: false, countryCode: "DK", baseCurrency: "DKK" })
    render(<NewPage />)
    await waitFor(() => expect(api.readiness).toHaveBeenCalled())
    const treatment = await screen.findByLabelText("vat.lineTreatment") as HTMLSelectElement
    expect([...treatment.options].map(option => option.value)).toEqual(expect.arrayContaining(["standard", "intra_community", "export", "exempt", "reverse_charge_domestic"]))
    expect(screen.queryByLabelText("vat.lineRate", { selector: "select" })).toBeNull()
    expect(screen.getByLabelText("docForm.summary.tax")).toBeTruthy()
  })
  it("sends an intra-community line with its evidence when no policy fixes the rate", async () => {
    api.readiness.mockResolvedValue({ issues: [], taxRate: "25", pricesIncludeTax: false, countryCode: "DK", baseCurrency: "DKK" })
    render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    fireEvent.change(await screen.findByLabelText("vat.lineTreatment"), { target: { value: "intra_community" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveDraft" })) })
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ vat: expect.objectContaining({ treatment: "intra_community", rate: "0" }) })] }))
  })
  it("offers the compact VAT choice only where a policy fixes the rate, and never a 0 % standard option", async () => {
    api.readiness.mockResolvedValue({ issues: [], taxRate: "0", standardVatRate: "0", pricesIncludeTax: false, countryCode: "DK", baseCurrency: "DKK" })
    render(<NewPage />)
    await waitFor(() => expect(screen.queryByLabelText("vat.lineTreatment")).toBeNull())
    const compact = screen.queryByLabelText("vat.lineRate") as HTMLSelectElement | null
    if (compact) expect([...compact.options].map(option => option.value)).not.toContain("standard")
  })
  it("ignores an AI-supplied VAT rate under a policy-fixed rate and applies it, correctably, otherwise", async () => {
    aiFixture.enabled = true
    api.generate.mockResolvedValue({ draft: { items: [{ description: "AI work", quantity: 1, unitPrice: 100 }], taxRate: 0 } })
    api.readiness.mockResolvedValue({ issues: [], taxRate: "25", standardVatRate: "25", baseCurrency: "DKK" })
    render(<NewPage />)
    await waitFor(() => expect(api.readiness).toHaveBeenCalled())
    fireEvent.change(await screen.findByLabelText("invoices.new.ai.label"), { target: { value: "Bill Synthetic Buyer" } })
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /invoices.new.ai.action.generate/ })) })
    fillDraft()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveDraft" })) })
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ taxRate: "25" }))
  })
})

describe("send errors and line validation on the new invoice form", () => {
  it("shows the server's own refusal instead of a generic message when sending fails after the draft exists", async () => {
    api.readiness.mockResolvedValue({ issues: [], taxRate: "25", pricesIncludeTax: false, baseCurrency: "DKK" })
    api.send.mockRejectedValue(new Error("Exemption requires reason text"))
    render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveSend" })) })
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith(expect.objectContaining({ search: expect.objectContaining({ sendError: "Exemption requires reason text" }) })))
  })
  it.each([
    ["a description over 500 characters", "docForm.column.description", "x".repeat(501), "invoiceValidation.description.tooLong"],
    ["an exponent unit price", "docForm.column.unitPrice", "1e2", "invoiceValidation.unitPrice.invalid"],
    ["a unit price with too many decimals", "docForm.column.unitPrice", "1.123456", "invoiceValidation.unitPrice.invalid"],
  ])("blocks %s", async (_name, label, value, message) => {
    render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveSend" })) })
    await screen.findByText(message)
    expect(api.create).not.toHaveBeenCalled()
  })
  it("treats missing bank details as a nudge that never blocks sending", async () => {
    api.readiness.mockResolvedValue({ issues: [], warnings: [{ code: "seller.bank.required", field: "seller.bankAccount", params: {} }], taxRate: "25", pricesIncludeTax: false, baseCurrency: "DKK" })
    render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    expect((await screen.findByTestId("organization-gaps")).getAttribute("role")).toBe("status")
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "docForm.action.saveSend" })) })
    expect(api.create).toHaveBeenCalledTimes(1)
  })
  it("shows an unsupported invoice currency reported by the readiness check", async () => {
    api.readiness.mockResolvedValue({ issues: [{ code: "currency.unsupported", field: "currency", params: { currencies: "DKK, EUR" } }], taxRate: "25", pricesIncludeTax: false, baseCurrency: "DKK" })
    render(<NewPage />)
    expect((await screen.findByRole("alert")).textContent).toBe("invoiceValidation.currency.unsupported")
  })
})
