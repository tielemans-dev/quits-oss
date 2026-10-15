// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ readiness: vi.fn(), create: vi.fn(), send: vi.fn(), navigate: vi.fn(), list: vi.fn(), get: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => api.navigate }))
vi.mock("../../../trpc/client", () => ({
  trpc: {
    contacts: { list: { query: async () => [{ id: "lindholm", name: "Lindholm & Bak I/S" }, { id: "other", name: "Andet ApS" }] } },
    catalog: { list: { query: async () => [] } },
    invoices: {
      sendReadiness: { query: api.readiness }, createV2: { mutate: api.create }, send: { mutate: api.send }, list: { query: api.list }, get: { query: api.get },
      learnedDefaults: { query: async () => ({ paymentTerms: null }) },
    },
  },
}))
vi.mock("../../../hooks/use-org-currency", () => ({ useOrgCurrency: () => "DKK" }))
vi.mock("../../../hooks/use-invoice-due-date", async importActual => ({ ...await importActual<typeof import("../../../hooks/use-invoice-due-date")>(), useInvoiceDueDate: () => ["2026-10-29", () => {}] }))
vi.mock("../../../lib/organization-settings-query", () => ({ loadOrganizationSettings: async () => ({ timezone: "UTC" }) }))

import { I18nProvider } from "../../../lib/i18n/react"
import { clearHandoff } from "../../../lib/request-handoff"
import { HeldSendToast } from "../held-send-toast"
import { InvoiceRequestCard } from "../invoice-request-card"
import { onRequestDone } from "../request-events"

const ready = { issues: [], recipientVersion: "v1", taxRate: "25", pricesIncludeTax: false, baseCurrency: "DKK" }
const lastInvoice = { id: "inv-146", number: "INV-0146", pricesIncludeTax: false, items: [{ description: "Designsparring, september", quantity: 20, displayUnitPrice: 900, vatTreatment: "standard", vatRateInput: null, vatCountry: null, vatReasonCode: null }] }
const text = () => (document.body.textContent ?? "").replace(/\u00a0/g, " ")

function renderCard(onDismiss = vi.fn()) {
  render(
    <I18nProvider locale="da-DK">
      <InvoiceRequestCard intent={{ kind: "repeat", input: "fakturer Lindholm som sidst" }} onDismiss={onDismiss} />
      <HeldSendToast />
    </I18nProvider>
  )
  return onDismiss
}
const hours = () => screen.findByRole("textbox", { name: /^Antal/ }) as Promise<HTMLInputElement>
const sendButton = () => screen.getByRole("button", { name: "Send faktura" }) as HTMLButtonElement
const clickSend = async () => {
  await waitFor(() => expect(sendButton().disabled).toBe(false))
  fireEvent.click(sendButton())
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  api.readiness.mockResolvedValue(ready)
  api.create.mockResolvedValue({ id: "inv-153", reviewedVersion: "r1" })
  api.send.mockResolvedValue({})
  // Newest first: a draft, another customer's, then the customer's last two.
  const row = (id: string, contactId: string, status: string) => ({ id, contactId, status, currency: "DKK" })
  api.list.mockResolvedValue([row("draft-1", "lindholm", "draft"), row("inv-other", "other", "sent"), row("inv-146", "lindholm", "paid"), row("inv-120", "lindholm", "paid")])
  api.get.mockResolvedValue(lastInvoice)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
  clearHandoff()
})

describe("repeat last invoice card", () => {
  it("copies the last issued invoice's lines, focuses the hours and computes the form's totals", async () => {
    renderCard()

    const field = await hours()
    expect(api.get).toHaveBeenCalledWith({ id: "inv-146" })
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(field.value).toBe("20")
    expect(text()).toContain("Designsparring, september")
    expect(text()).toContain("Kopieret fra INV-0146")
    await waitFor(() => expect(text()).toContain("22.500,00 kr."))
    expect(text()).toMatch(/Subtotal18\.000,00 kr\.Moms 25 %4\.500,00 kr\./)
    expect(text()).toContain("29.10.2026")
    expect(api.create).not.toHaveBeenCalled()
  })

  it("updates the totals as the hours change, and refuses hours that are no quantity", async () => {
    renderCard()
    const field = await hours()

    fireEvent.change(field, { target: { value: "10,5" } })

    await waitFor(() => expect(text()).toContain("11.812,50 kr."))
    expect(text()).toMatch(/Subtotal9\.450,00 kr\.Moms 25 %2\.362,50 kr\./)
    fireEvent.change(field, { target: { value: "abc" } })
    await waitFor(() => expect(text()).toContain("Mangler: Antal"))
    expect(sendButton().disabled).toBe(true)
  })

  it("makes nothing at the click, and sends after the wait with the edited hours", async () => {
    const done = vi.fn()
    const off = onRequestDone(done)
    const onDismiss = renderCard()
    fireEvent.change(await hours(), { target: { value: "10" } })

    await clickSend()

    await screen.findByText("Sender faktura til Lindholm & Bak I/S om 8 s")
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(api.create).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(7900) })
    expect(api.create).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ id: "inv-153", reviewedVersion: "r1" })))
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      contactId: "lindholm",
      dueDate: "2026-10-29",
      supplyDate: new Date().toISOString().slice(0, 10),
      reviewedRecipient: "v1",
      pricesIncludeTax: false,
      items: [{ description: "Designsparring, september", quantity: "10", unitPrice: "900", vat: undefined }],
    }))
    await waitFor(() => expect(done).toHaveBeenCalledWith({ kind: "invoice", invoiceId: "inv-153" }))
    off()
  })

  it("makes nothing at all after Fortryd", async () => {
    renderCard()
    await clickSend()

    fireEvent.click(await screen.findByRole("button", { name: "Fortryd" }))
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })

    expect(api.create).not.toHaveBeenCalled()
    expect(api.send).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Fortryd" })).toBeNull()
  })

  it("says so when the invoice could not be made, instead of showing it as sent", async () => {
    api.create.mockRejectedValue(new Error("down"))
    renderCard()
    await clickSend()

    await act(async () => { await vi.advanceTimersByTimeAsync(8100) })

    expect((await screen.findByRole("alert")).textContent).toContain("Fakturaen til Lindholm & Bak I/S blev ikke sendt.")
    fireEvent.click(screen.getByRole("button", { name: "Luk" }))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("says there is nothing to copy for a customer without an issued invoice", async () => {
    api.list.mockResolvedValue([{ id: "draft-1", contactId: "lindholm", status: "draft", currency: "DKK" }])
    renderCard()

    await screen.findByText("Der er ingen tidligere faktura til kunden at kopiere.")
    expect(sendButton().disabled).toBe(true)
    expect(api.get).not.toHaveBeenCalled()
  })
})
