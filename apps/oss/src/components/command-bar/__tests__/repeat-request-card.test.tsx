// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ readiness: vi.fn(), create: vi.fn(), send: vi.fn(), navigate: vi.fn(), list: vi.fn(), get: vi.fn(), later: vi.fn(), held: vi.fn(), cancel: vi.fn(), release: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => api.navigate }))
vi.mock("../../../trpc/client", () => ({
  trpc: {
    jobs: { sendInvoiceLater: { mutate: api.later }, held: { query: api.held }, cancelHeld: { mutate: api.cancel }, release: { mutate: api.release } },
    contacts: { list: { query: async () => [{ id: "lindholm", name: "Lindholm & Bak I/S" }, { id: "other", name: "Andet ApS" }] } },
    catalog: { list: { query: async () => [] } },
    invoices: {
      sendReadiness: { query: api.readiness }, createV2: { mutate: api.create }, send: { mutate: api.send }, list: { query: api.list }, get: { query: api.get },
      learnedDefaults: { query: async () => ({ paymentTerms: null }) },
    },
  },
}))
vi.mock("../../../hooks/use-org-currency", () => ({ useOrgCurrency: () => "DKK", useOrgCurrencyState: () => ({ currency: "DKK", loaded: true }) }))
vi.mock("../../../hooks/use-invoice-due-date", async importActual => ({ ...await importActual<typeof import("../../../hooks/use-invoice-due-date")>(), useInvoiceDueDate: () => ["2026-10-29", () => {}] }))
vi.mock("../../../lib/organization-settings-query", () => ({ loadOrganizationSettings: async () => ({ timezone: "UTC" }) }))

import { I18nProvider } from "../../../lib/i18n/react"
import { clearHandoff } from "../../../lib/request-handoff"
import { removeUndo } from "../../undo/undo-store"
import { UndoToaster } from "../../undo/undo-toaster"
import { InvoiceRequestCard } from "../invoice-request-card"
import { onRequestDone } from "../request-events"
import { resetRequestDataForTesting } from "../request-data"
import { handledMutationError } from "../../../lib/query-refresh"

// Cards share their reads for a few seconds; every test starts without them.
beforeEach(() => resetRequestDataForTesting())

const ready = { issues: [], recipientVersion: "v1", taxRate: "25", pricesIncludeTax: false, baseCurrency: "DKK" }
const lastInvoice = { id: "inv-146", number: "INV-0146", pricesIncludeTax: false, items: [{ description: "Designsparring, september", quantity: 20, displayUnitPrice: 900, vatTreatment: "standard", vatRateInput: null, vatCountry: null, vatReasonCode: null }] }
const text = () => (document.body.textContent ?? "").replace(/\u00a0/g, " ")

function renderCard(onDismiss = vi.fn()) {
  render(
    <I18nProvider locale="da-DK">
      <InvoiceRequestCard intent={{ kind: "repeat", input: "fakturer Lindholm som sidst" }} onDismiss={onDismiss} />
      <UndoToaster />
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
  api.held.mockResolvedValue([])
  api.later.mockImplementation(async () => {
    api.held.mockResolvedValue([{ id: "repeat-job", type: "invoice.delayed_send", steps: 0, heldForMs: 8000, invoiceId: "inv-153" }])
    return { jobId: "repeat-job" }
  })
  api.cancel.mockResolvedValue({})
  api.release.mockResolvedValue({ status: "done", error: null })
  // Newest first: a draft, another customer's, then the customer's last two.
  const row = (id: string, contactId: string, status: string) => ({ id, contactId, status, currency: "DKK" })
  api.list.mockResolvedValue([row("draft-1", "lindholm", "draft"), row("inv-other", "other", "sent"), row("inv-146", "lindholm", "paid"), row("inv-120", "lindholm", "paid")])
  api.get.mockResolvedValue(lastInvoice)
})
afterEach(() => {
  cleanup()
  removeUndo("repeat-job")
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
    expect((screen.getByLabelText("Forfaldsdato") as HTMLInputElement).value).toBe("29.10.2026")
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

  it("queues the edited repeat immediately, restores one undo toast on reload, and releases after the window", async () => {
    const done = vi.fn()
    const off = onRequestDone(done)
    renderCard()
    fireEvent.change(await hours(), { target: { value: "10" } })
    await clickSend()
    await screen.findByRole("button", { name: "Fortryd" })
    expect(api.later).toHaveBeenCalledWith(expect.objectContaining({ id: "inv-153", reviewedVersion: "r1" }), handledMutationError)
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      contactId: "lindholm", reviewedRecipient: "v1",
      items: [{ description: "Designsparring, september", quantity: "10", unitPrice: "900", vat: undefined }],
    }), handledMutationError)
    expect(screen.getAllByRole("button", { name: "Fortryd" })).toHaveLength(1)
    expect(document.querySelector("[data-slot=held-send-toast]")).toBeNull()

    // A reload discards the card and all client undo state. Only the server's job remains.
    cleanup()
    removeUndo("repeat-job")
    api.held.mockResolvedValue([{ id: "repeat-job", type: "invoice.delayed_send", steps: 0, heldForMs: 4000, invoiceId: "inv-153" }])
    render(<I18nProvider locale="da-DK"><UndoToaster /></I18nProvider>)
    await screen.findByRole("button", { name: "Fortryd" })
    expect(screen.getAllByRole("button", { name: "Fortryd" })).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(3800) })
    expect(api.release).not.toHaveBeenCalled()
    expect(api.send).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(api.release).toHaveBeenCalledWith({ jobId: "repeat-job" })
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(done).toHaveBeenCalledWith({ kind: "invoice", invoiceId: "inv-153" })
    off()
  })

  it("Fortryd cancels the server job and never releases it", async () => {
    renderCard()
    await clickSend()
    fireEvent.click(await screen.findByRole("button", { name: "Fortryd" }))
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(api.cancel).toHaveBeenCalledWith({ jobId: "repeat-job" })
    expect(api.release).not.toHaveBeenCalled()
    expect(api.send).not.toHaveBeenCalled()
  })

  it("reports a draft creation failure without queuing a send", async () => {
    api.create.mockRejectedValue(new Error("down"))
    renderCard()
    await clickSend()
    expect((await screen.findByRole("alert")).textContent).toBeTruthy()
    expect(api.later).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Fortryd" })).toBeNull()
  })

  it("says there is nothing to copy for a customer without an issued invoice", async () => {
    api.list.mockResolvedValue([{ id: "draft-1", contactId: "lindholm", status: "draft", currency: "DKK" }])
    renderCard()

    await screen.findByText("Der er ingen tidligere faktura til kunden at kopiere.")
    expect(sendButton().disabled).toBe(true)
    expect(api.get).not.toHaveBeenCalled()
  })
})
