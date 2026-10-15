// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ bankReadiness: vi.fn(), create: vi.fn(), send: vi.fn(), resend: vi.fn(), settings: vi.fn(), contacts: vi.fn(), navigate: vi.fn(), generate: vi.fn(), get: vi.fn(), currency: "DKK" }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options, useParams: () => ({ invoiceId: "synthetic-invoice" }), useSearch: () => ({}) }),
  Link: ({ children, to, onClick }: { children: ReactNode; to: string; onClick?: () => void }) => <a href={to} onClick={event => { event.preventDefault(); onClick?.(); api.navigate({ to }) }}>{children}</a>,
  useNavigate: () => api.navigate,
}))
vi.mock("../../trpc/client", () => ({ trpc: {
  invoices: { get: { query: api.get }, createV2: { mutate: api.create }, send: { mutate: api.send }, resendEmail: { mutate: api.resend } },
  paymentDetails: { firstSendReadiness: { query: api.bankReadiness } },
  contacts: { list: { query: api.contacts } }, catalog: { list: { query: async () => [] } },
  ai: { generateInvoiceDraft: { mutate: api.generate } },
  runtime: { capabilities: { query: async () => ({ aiInvoiceDraft: { enabled: false, byok: false } }) } }, settings: { get: { query: api.settings } },
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
  api.contacts.mockResolvedValue([contact])
  api.settings.mockResolvedValue({ locale: "en-US", timezone: "UTC", baseCurrency: "DKK", taxRate: 25, pricesIncludeTax: false, emailDelivery: { available: true }, companyName: "Synthetic Studio" })
  api.create.mockResolvedValue({ id: invoice.id })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

function fillDraft() {
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: contact.id } })
  fireEvent.change(document.getElementById("dueDate")!, { target: { value: "2099-01-01" } })
  fireEvent.change(screen.getByPlaceholderText("docForm.column.description"), { target: { value: "Synthetic work" } })
}
describe("invoice review regressions", () => {
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
    expect(api.create).toHaveBeenCalledWith({ contactId: contact.id, dueDate: "2099-01-01", supplyDate: "2026-10-05", taxRate: "25", vatEvidence: { statementText: "Synthetic exemption evidence" }, notes: "Keep these notes", items: [{ description: "Synthetic work", quantity: "2", unitPrice: "123.45", vat: { treatment: "exempt", rate: "0", reasonCode: "financial", country: null } }] })
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
    expect((screen.getByPlaceholderText("docForm.column.description") as HTMLInputElement).value).toBe("Synthetic work")
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
