// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ readiness: vi.fn(), create: vi.fn(), send: vi.fn(), navigate: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => api.navigate }))
vi.mock("../../../trpc/client", () => ({
  trpc: {
    contacts: { list: { query: async () => [{ id: "buyer", name: "Havbrise Logistik A/S", email: "buyer@example.test" }] } },
    catalog: { list: { query: async () => [] } },
    invoices: { sendReadiness: { query: api.readiness }, createV2: { mutate: api.create }, send: { mutate: api.send } },
  },
}))
vi.mock("../../../hooks/use-org-currency", () => ({ useOrgCurrency: () => "DKK" }))
vi.mock("../../../hooks/use-invoice-due-date", () => ({ useInvoiceDueDate: () => ["2026-11-14", () => {}] }))

import { I18nProvider } from "../../../lib/i18n/react"
import { clearHandoff, handOff, readHandoff, type InvoiceHandoff } from "../../../lib/request-handoff"
import { InvoiceRequestCard } from "../invoice-request-card"
import { onRequestDone } from "../request-events"

const ready = { issues: [], recipientVersion: "v1", taxRate: "25", pricesIncludeTax: false, baseCurrency: "DKK" }
const text = () => (document.body.textContent ?? "").replace(/ /g, " ")

function renderCard(input: string, onDismiss = vi.fn()) {
  render(
    <I18nProvider locale="da-DK">
      <InvoiceRequestCard intent={{ kind: "invoice", input }} onDismiss={onDismiss} />
    </I18nProvider>
  )
  return onDismiss
}

async function send() {
  const button = () => screen.getByRole("button", { name: "Send faktura" }) as HTMLButtonElement
  await waitFor(() => expect(button().disabled).toBe(false))
  fireEvent.click(button())
}

beforeEach(() => {
  api.readiness.mockResolvedValue(ready)
  api.create.mockResolvedValue({ id: "inv-1", reviewedVersion: "r1" })
  api.send.mockResolvedValue({})
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
  clearHandoff()
})

describe("invoice request card", () => {
  it("fills in the invoice from the request with the form's totals, and creates nothing by itself", async () => {
    renderCard("faktura til Havbrise Logistik A/S 10 timer à 850 kr. konsulent")

    await waitFor(() => expect(text()).toContain("10.625,00 kr."))
    expect(text()).toContain("Havbrise Logistik A/S")
    expect(text()).toContain("konsulent")
    expect(text()).toMatch(/Subtotal8\.500,00 kr\.Moms 25 %2\.125,00 kr\./)
    expect(api.create).not.toHaveBeenCalled()
  })

  it("names what is missing and does not offer to send", async () => {
    renderCard("faktura til Havbrise Logistik A/S 10 timer konsulent")

    await waitFor(() => expect(text()).toContain("Mangler: Enhedspris"))
    expect((screen.getByRole("button", { name: "Send faktura" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("sends through the form's create and send, shows the check, then lets go and tells the page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const done = vi.fn()
    const off = onRequestDone(done)
    const onDismiss = renderCard("faktura til Havbrise Logistik A/S 10 timer à 850 kr. konsulent")

    await send()

    await screen.findByText("Faktura sendt")
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "buyer",
        dueDate: "2026-11-14",
        reviewedRecipient: "v1",
        items: [{ description: "konsulent", quantity: "10", unitPrice: "850", vat: undefined }],
      })
    )
    expect(api.send).toHaveBeenCalledWith(expect.objectContaining({ id: "inv-1", reviewedVersion: "r1" }))
    expect(text()).toContain("10.625,00 kr. · Havbrise Logistik A/S")
    expect(onDismiss).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(1950) })
    expect(done).toHaveBeenCalledWith({ kind: "invoice", invoiceId: "inv-1" })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    off()
  })

  it("hands the invoice to the form on Rediger without creating anything", async () => {
    const onDismiss = renderCard("faktura til Havbrise Logistik A/S 10 timer à 850 kr. konsulent")
    await waitFor(() => expect((screen.getByRole("button", { name: "Rediger" }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByRole("button", { name: "Rediger" }))

    expect(readHandoff("form")).toMatchObject({ contactId: "buyer", dueDate: "2026-11-14", taxRate: "25", items: [{ description: "konsulent", quantity: "10", unitPrice: "850" }] })
    expect(api.navigate).toHaveBeenCalledWith({ to: "/invoices/new" })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(api.create).not.toHaveBeenCalled()
  })

  it("comes back from the form with the edits, not the request", async () => {
    const edited: InvoiceHandoff = {
      input: "faktura til Havbrise Logistik A/S 10 timer à 850 kr. konsulent", contactId: "buyer", dueDate: "2026-12-01",
      issuance: { supplyDate: "2026-10-01", exchangeRate: "", rateDate: "2026-10-01" }, taxRate: "25", pricesIncludeTax: false, vatEvidence: {}, notes: "Tak",
      items: [{ description: "konsulent", quantity: "2,5", unitPrice: "850" }, { description: "rejse", quantity: "1", unitPrice: "400" }],
    }
    handOff("card", edited)
    renderCard(edited.input)

    await waitFor(() => expect(text()).toContain("3.156,25 kr."))
    expect(text()).toContain("rejse")
    expect(text()).toContain("1. dec. 2026")
    await send()
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      notes: "Tak",
      items: [expect.objectContaining({ description: "konsulent", quantity: "2.5" }), expect.objectContaining({ description: "rejse" })],
    })))
    expect(readHandoff("card")).toBeNull()
  })

  it("shows the invoice's own error when the send fails after the draft exists", async () => {
    api.send.mockRejectedValue(new Error("Mailudbyderen afviste mailen"))
    const onDismiss = renderCard("faktura til Havbrise Logistik A/S 10 timer à 850 kr. konsulent")
    await send()

    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith(expect.objectContaining({
      params: { invoiceId: "inv-1" },
      search: { emailWarning: undefined, sendError: "Mailudbyderen afviste mailen" },
    })))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("keeps the card and says so when nothing could be created", async () => {
    api.create.mockRejectedValue(new Error("down"))
    renderCard("faktura til Havbrise Logistik A/S 10 timer à 850 kr. konsulent")
    await send()

    await screen.findByRole("alert")
    expect(api.navigate).not.toHaveBeenCalled()
    expect(api.send).not.toHaveBeenCalled()
  })
})
