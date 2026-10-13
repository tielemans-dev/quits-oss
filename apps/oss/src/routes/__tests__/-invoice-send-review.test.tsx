// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ bankReadiness: vi.fn(), create: vi.fn(), send: vi.fn(), resend: vi.fn(), settings: vi.fn(), contacts: vi.fn(), navigate: vi.fn(), generate: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options, useParams: () => ({ invoiceId: "synthetic-invoice" }), useSearch: () => ({}) }),
  Link: ({ children, to, onClick }: { children: ReactNode; to: string; onClick?: () => void }) => <a href={to} onClick={event => { event.preventDefault(); onClick?.(); api.navigate({ to }) }}>{children}</a>,
  useNavigate: () => api.navigate,
}))
vi.mock("../../trpc/client", () => ({ trpc: {
  invoices: { createV2: { mutate: api.create }, send: { mutate: api.send }, resendEmail: { mutate: api.resend } },
  paymentDetails: { firstSendReadiness: { query: api.bankReadiness } },
  contacts: { list: { query: api.contacts } }, catalog: { list: { query: async () => [] } },
  ai: { generateInvoiceDraft: { mutate: api.generate } },
  runtime: { capabilities: { query: async () => ({ aiInvoiceDraft: { enabled: false, byok: false } }) } }, settings: { get: { query: api.settings } },
} }))
vi.mock("../../hooks/use-org-currency", () => ({ useOrgCurrency: () => "DKK" }))
vi.mock("../../lib/auth-client", () => ({ useSession: () => ({ data: { session: { activeOrganizationId: "synthetic-org" } }, isPending: false }) }))
vi.mock("../../components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: ReactNode }) => <select value={value ?? ""} onChange={event => onValueChange(event.target.value)}><option value="" />{children}</select>,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
  SelectTrigger: () => null, SelectValue: () => null,
}))
vi.mock("../../components/localized-date-field", () => ({ LocalizedDateField: ({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) => <input id={id} type="date" value={value} onChange={event => onChange(event.target.value)} /> }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ locale: "en-US", t: (key: string) => key }) }))
import { initializeRequestOrganizationId, resetRequestOrganizationForTesting } from "../../lib/active-organization"
import { Route as NewRoute } from "../_app/invoices/new"
const NewPage = (NewRoute as unknown as { component: ComponentType }).component
const contact = { id: "synthetic-buyer", name: "Synthetic Buyer", email: "buyer@example.test", company: "Synthetic Buyer", address: null, city: null, state: null, zip: null, country: "DK" }
const invoice = { id: "synthetic-invoice" }
beforeEach(() => {
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
  it("persists the complete draft before bank Settings navigation without sending", async () => {
    let persist!: (value: { id: string }) => void
    api.create.mockReturnValue(new Promise(resolve => { persist = resolve }))
    api.bankReadiness.mockResolvedValue({ bankMissing: true })
    render(<NewPage />)
    await screen.findByRole("option", { name: contact.name })
    fillDraft()
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "2" } })
    fireEvent.change(screen.getAllByRole("spinbutton")[1], { target: { value: "123.45" } })
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
