// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ list: vi.fn(), record: vi.fn(), void: vi.fn(), can: vi.fn() }))
vi.mock("../../../trpc/client", () => ({
  trpc: {
    invoices: { list: { query: api.list } },
    settings: { get: { query: async () => ({ timezone: "Europe/Copenhagen" }) } },
    payments: { record: { mutate: api.record }, void: { mutate: api.void } },
  },
}))
vi.mock("../../shell/use-shell-permissions", () => ({ useShellPermissions: () => ({ can: api.can, ready: true }) }))

import { I18nProvider } from "../../../lib/i18n/react"
import { PaymentMatchCard } from "../payment-match-card"
import { resetRequestDataForTesting } from "../request-data"

// Cards share their reads for a few seconds; every test starts without them.
beforeEach(() => resetRequestDataForTesting())

const invoice = (id: string, name: string, balanceDue: number) => ({
  id, number: `F-${id}`, status: "sent", paymentStatus: "unpaid", balanceDue, currency: "DKK", contact: { name },
})
const text = () => (document.body.textContent ?? "").replace(/[  ]/g, " ")

function renderCard(input: string) {
  render(
    <I18nProvider locale="da-DK">
      <PaymentMatchCard intent={{ kind: "payment", input }} onDismiss={vi.fn()} />
    </I18nProvider>
  )
}
const markPaid = (name = "Markér som betalt") => screen.findByRole("button", { name }) as Promise<HTMLButtonElement>

beforeEach(() => {
  api.can.mockReturnValue(true)
  api.record.mockResolvedValue({ payment: { id: "pay-1" }, balanceDue: 0 })
  api.void.mockResolvedValue({})
  api.list.mockResolvedValue([invoice("1042", "Havbrise Logistik A/S", 1250.5), invoice("1043", "Nordlys ApS", 1250.5), invoice("1044", "Nordlys ApS", 1240.5)])
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe("payment match card", () => {
  it("shows the payment and the one invoice it pays, and records nothing until the click", async () => {
    renderCard("betaling modtaget fra J. Hansen 1.250,50 kr ref faktura F-1042")
    const button = await markPaid()

    expect(text()).toContain("J. Hansen")
    expect(text()).toContain("1.250,50 kr.")
    expect(text()).toContain("faktura F-1042")
    expect(text()).toContain("Havbrise Logistik A/S")
    expect(text()).not.toContain("Nordlys")
    expect(api.record).not.toHaveBeenCalled()

    fireEvent.click(button)
    await screen.findByText("Faktura markeret som betalt")
    expect(api.record).toHaveBeenCalledTimes(1)
    expect(api.record).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: "1042", amount: 1250.5, method: "bank_transfer", reference: "faktura F-1042", paidAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }))
  })

  it("sends the same request id when the person retries after a failure", async () => {
    api.record.mockRejectedValueOnce(new Error("offline"))
    renderCard("betaling fra J. Hansen 1.250,50 kr ref F-1042")
    fireEvent.click(await markPaid())
    await screen.findByText("Betalingen blev ikke registreret.")
    fireEvent.click(await markPaid())
    await screen.findByText("Faktura markeret som betalt")

    expect(api.record).toHaveBeenCalledTimes(2)
    expect(api.record.mock.calls[1]![0].requestId).toBe(api.record.mock.calls[0]![0].requestId)
  })

  it("offers a shortlist without choosing, and records only the pick", async () => {
    renderCard("betaling fra Nordlys 1.250,50 kr")
    const button = await markPaid()

    expect(screen.getAllByRole("radio")).toHaveLength(1)
    expect(button.disabled).toBe(true)
    fireEvent.click(screen.getByRole("radio"))
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await screen.findByText("Faktura markeret som betalt")
    expect(api.record).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: "1043", amount: 1250.5 }))
  })

  it("records a short payment as a partial payment, with what is missing in view", async () => {
    renderCard("betaling fra Nordlys 1.240,50 kr ref F-1044")
    fireEvent.click(await markPaid())
    await screen.findByText("Faktura markeret som betalt")

    cleanup()
    renderCard("betaling fra Nordlys 1.200 kr")
    fireEvent.click(await screen.findByRole("radio", { name: /F-1044/ }))
    expect(text()).toContain("mangler 40,50 kr.")
    fireEvent.click(await markPaid("Registrér delbetaling"))
    await screen.findByText("Delbetaling registreret")
    expect(api.record).toHaveBeenLastCalledWith(expect.objectContaining({ invoiceId: "1044", amount: 1200 }))
  })

  it("voids the payment on Fortryd, and hides Fortryd from someone who may not void", async () => {
    renderCard("betaling fra J. Hansen 1.250,50 kr ref F-1042")
    fireEvent.click(await markPaid())
    fireEvent.click(await screen.findByRole("button", { name: "Fortryd" }))
    await waitFor(() => expect(api.void).toHaveBeenCalledWith({ paymentId: "pay-1", reason: expect.any(String) }))
    await screen.findByText("Betalingen er fortrudt")

    cleanup()
    api.can.mockReturnValue(false)
    renderCard("betaling fra J. Hansen 1.250,50 kr ref F-1042")
    fireEvent.click(await markPaid())
    await screen.findByText("Faktura markeret som betalt")
    expect(screen.queryByRole("button", { name: "Fortryd" })).toBeNull()
  })

  it("says so when nothing fits, and offers no button", async () => {
    renderCard("betaling fra Ukendt 99 kr")
    await screen.findByText("Ingen åbne fakturaer passer til betalingen.")
    expect(screen.queryByRole("button", { name: "Markér som betalt" })).toBeNull()
  })
})
