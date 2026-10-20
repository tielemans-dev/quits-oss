// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ readiness: vi.fn(), create: vi.fn(), send: vi.fn(), later: vi.fn(), held: vi.fn(), navigate: vi.fn(), learned: vi.fn(), clear: vi.fn(), restore: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => api.navigate }))
vi.mock("../../../trpc/client", () => ({
  trpc: {
    contacts: { list: { query: async () => [{ id: "buyer", name: "Havbrise Logistik A/S", email: "buyer@example.test" }] } },
    catalog: { list: { query: async () => [] } },
    invoices: {
      sendReadiness: { query: api.readiness }, createV2: { mutate: api.create }, send: { mutate: api.send },
      learnedDefaults: { query: api.learned }, clearLearnedDefault: { mutate: api.clear }, restoreLearnedDefault: { mutate: api.restore },
    },
    jobs: { sendInvoiceLater: { mutate: api.later }, held: { query: api.held } },
  },
}))
vi.mock("../../../hooks/use-org-currency", () => ({ useOrgCurrency: () => "DKK" }))
vi.mock("../../../hooks/use-invoice-due-date", async importActual => ({ ...await importActual<typeof import("../../../hooks/use-invoice-due-date")>(), useInvoiceDueDate: () => ["2026-11-14", () => {}] }))
vi.mock("../../../lib/organization-settings-query", () => ({ loadOrganizationSettings: async () => ({ timezone: "UTC" }) }))

import { fillRequest } from "../../../lib/ai/request-fallback"
import { I18nProvider } from "../../../lib/i18n/react"
import { clearHandoff, handOff, readHandoff, type InvoiceHandoff } from "../../../lib/request-handoff"
import { InvoiceRequestCard } from "../invoice-request-card"
import { onRequestDone } from "../request-events"
import { resetRequestDataForTesting } from "../request-data"

// Cards share their reads for a few seconds; every test starts without them.
beforeEach(() => resetRequestDataForTesting())

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
  api.learned.mockResolvedValue({ paymentTerms: null })
  api.clear.mockResolvedValue({ cleared: true })
  api.restore.mockResolvedValue(undefined)
  api.later.mockResolvedValue({ jobId: "job-1" })
  api.held.mockResolvedValue([])
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

  it("renders model fields as editable, recalculates totals and hands edited fields to the form without a write", async () => {
    const input = "Lav en regning for rådgivning til Havbrise"
    const suggested = await fillRequest({
      enabled: true, input, context: { customers: [{ id: "buyer", name: "Havbrise Logistik A/S" }], catalogItems: [] },
      resolve: async () => ({ model: "test", provider: { id: "openai_compatible", complete: vi.fn(async () => JSON.stringify({ intent: "invoice", customerQuery: "Havbrise", items: [{ description: "Rådgivning", quantity: "10", unitPrice: "850" }, { description: "Transport", quantity: "1", unitPrice: "100" }] })) } }),
    })
    render(<I18nProvider locale="da-DK"><InvoiceRequestCard intent={{ kind: "invoice", input, suggested: suggested! }} onDismiss={() => {}} /></I18nProvider>)
    await waitFor(() => expect(text()).toContain("10.750,00 kr."))
    expect(screen.getByRole("combobox", { name: "Kunde" })).toBeTruthy()
    fireEvent.change(screen.getAllByRole("textbox", { name: "Antal" })[0]!, { target: { value: "12" } })
    await waitFor(() => expect(text()).toContain("12.875,00 kr."))
    expect(api.create).not.toHaveBeenCalled()
    expect(api.send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Rediger" }))
    expect(readHandoff("form")).toMatchObject({ suggested, items: [{ description: "Rådgivning", quantity: "12", unitPrice: "850" }, { description: "Transport", quantity: "1", unitPrice: "100" }] })
  })

  it("asks for what the request left out in its place, and only then offers to send", async () => {
    renderCard("faktura til Havbrise Logistik A/S 10 timer konsulent")

    const price = await screen.findByRole("spinbutton", { name: "Enhedspris" })
    const sendButton = () => screen.getByRole("button", { name: "Send faktura" }) as HTMLButtonElement
    await waitFor(() => expect(text()).toContain("Subtotal"))
    expect(sendButton().disabled).toBe(true)
    expect(text()).not.toContain("Mangler")

    fireEvent.change(price, { target: { value: "850" } })
    await waitFor(() => expect(sendButton().disabled).toBe(false))
  })

  it("creates the draft, holds the send for the undo window, shows the check, then lets go without telling the page it is sent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const done = vi.fn()
    const off = onRequestDone(done)
    const onDismiss = renderCard("faktura til Havbrise Logistik A/S 10 timer à 850 kr. konsulent")

    await send()

    await screen.findByText("Faktura sendes")
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "buyer",
        dueDate: "2026-11-14",
        reviewedRecipient: "v1",
        items: [{ description: "konsulent", quantity: "10", unitPrice: "850", vat: undefined }],
      })
    )
    // Nothing leaves now: the send is queued to run when the window closes, and Fortryd can still cancel it.
    expect(api.later).toHaveBeenCalledWith(expect.objectContaining({ id: "inv-1", reviewedVersion: "r1" }))
    expect(api.send).not.toHaveBeenCalled()
    expect(text()).toContain("10.625,00 kr. · Havbrise Logistik A/S")
    expect(onDismiss).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(1950) })
    expect(done).not.toHaveBeenCalled() // the page hears of the invoice when it has really gone out
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
    expect((screen.getByLabelText("Forfaldsdato") as HTMLInputElement).value).toBe("01.12.2026")
    await send()
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      notes: "Tak",
      items: [expect.objectContaining({ description: "konsulent", quantity: "2.5" }), expect.objectContaining({ description: "rejse" })],
    })))
    expect(readHandoff("card")).toBeNull()
  })

  it("shows the invoice's own error when the send fails after the draft exists", async () => {
    api.later.mockRejectedValue(new Error("Mailudbyderen afviste mailen"))
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
    expect(api.later).not.toHaveBeenCalled()
  })

  describe("som sidst", () => {
    const request = "faktura til Havbrise Logistik A/S 10 timer à 850 kr. konsulent"
    const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

    it("pre-fills the learned due date with a hint, counted by code, and sends what the field holds", async () => {
      api.learned.mockResolvedValue({ paymentTerms: { days: 8, count: 3 } })
      renderCard(request)

      await screen.findByText("som sidst · 8 dage")
      expect(api.learned).toHaveBeenCalledWith({ contactId: "buyer" })
      await send()
      await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ dueDate: inDays(8) })))
    })

    it("shows no hint and keeps the organization's date without a learned default", async () => {
      renderCard(request)

      await waitFor(() => expect(api.learned).toHaveBeenCalled())
      expect(text()).not.toContain("som sidst")
      await send()
      await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ dueDate: "2026-11-14" })))
    })

    it("drops the hint when the date is changed on the card", async () => {
      api.learned.mockResolvedValue({ paymentTerms: { days: 8, count: 2 } })
      renderCard(request)
      await screen.findByText("som sidst · 8 dage")

      fireEvent.change(screen.getByLabelText("Forfaldsdato"), { target: { value: "" } })
      fireEvent.blur(screen.getByLabelText("Forfaldsdato"))

      await waitFor(() => expect(text()).not.toContain("som sidst"))
      expect(api.clear).not.toHaveBeenCalled()
    })

    it("clears a learned default, sends the organization's date, and brings the hint back with Fortryd", async () => {
      api.learned.mockResolvedValue({ paymentTerms: { days: 8, count: 3 } })
      renderCard(request)
      await screen.findByText("som sidst · 8 dage")

      fireEvent.click(screen.getByRole("button", { name: "Fjern det lærte forfald" }))
      await screen.findByText("Det lærte forfald er fjernet.")
      expect(api.clear).toHaveBeenCalledWith({ contactId: "buyer" })
      expect(text()).not.toContain("som sidst")

      fireEvent.click(screen.getByRole("button", { name: "Fortryd" }))
      await screen.findByText("som sidst · 8 dage")
      expect(api.restore).toHaveBeenCalledWith({ contactId: "buyer" })
    })

    it("says so and keeps the hint when clearing fails", async () => {
      api.learned.mockResolvedValue({ paymentTerms: { days: 8, count: 3 } })
      api.clear.mockRejectedValue(new Error("down"))
      renderCard(request)
      await screen.findByText("som sidst · 8 dage")

      fireEvent.click(screen.getByRole("button", { name: "Fjern det lærte forfald" }))

      await screen.findByText("Det lærte forfald kunne ikke ændres. Prøv igen.")
      expect(text()).toContain("som sidst · 8 dage")
    })
  })
})
