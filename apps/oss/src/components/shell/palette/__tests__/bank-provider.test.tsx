// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ record: vi.fn(), void: vi.fn() }))
vi.mock("../../../../trpc/client", () => ({ trpc: { payments: { record: { mutate: api.record }, void: { mutate: api.void } } } }))

import { I18nProvider } from "../../../../lib/i18n/react"
import type { MatchInvoice } from "../../../../lib/payments/payment-match"
import { BankCard, readBankDate, readBankLine, type Line } from "../bank-provider"

afterEach(() => {
  cleanup()
  api.record.mockReset()
  api.void.mockReset()
})

describe("readBankLine", () => {
  it("takes the last amount with øre as what came in, and the rest as who paid and why", () => {
    expect(readBankLine("16.10.2026 Overførsel Birk Arkitekter ApS INV-2026-001 18.500,00")).toEqual({
      payer: "Overførsel Birk Arkitekter ApS INV-2026-001", amountMinor: 1_850_000, currency: "DKK", reference: "Overførsel Birk Arkitekter ApS INV-2026-001",
    })
    expect(readBankLine("Studio Vester faktura 3 12.000,00")?.amountMinor).toBe(1_200_000)
  })

  it("is no payment for money going out, a line without an amount, or an amount alone", () => {
    expect(readBankLine("16.10.2026 Husleje -12.000,00")).toBeNull()
    expect(readBankLine("fakturer birk 5 timer")).toBeNull()
    expect(readBankLine("16.10.2026 18.500,00")).toBeNull()
  })
})

describe("readBankDate", () => {
  it("reads the booking date in the forms banks write it", () => {
    expect(readBankDate("16.10.2026 Overførsel Birk 100,00")).toBe("2026-10-16")
    expect(readBankDate("16-10-26 Overførsel Birk 100,00")).toBe("2026-10-16")
    expect(readBankDate("2026-10-16 Overførsel Birk 100,00")).toBe("2026-10-16")
  })

  it("is null for a line without a date or with one that does not exist", () => {
    expect(readBankDate("Overførsel Birk 100,00")).toBeNull()
    expect(readBankDate("31.02.2026 Overførsel Birk 100,00")).toBeNull()
  })
})

const invoice = (id: string, number: string, name: string): MatchInvoice => ({ id, number, status: "sent", paymentStatus: "unpaid", balanceDue: 100, currency: "DKK", contact: { name } })
const candidate = (match: MatchInvoice) => ({ invoice: match, shortMinor: 0, byReference: true, nameScore: 1 })
const line = (text: string, match: MatchInvoice | null): Line => ({
  text, payment: readBankLine(text)!, paidOn: readBankDate(text), candidates: match ? [candidate(match)] : [], exact: Boolean(match),
})
const shortlist = (text: string, matches: MatchInvoice[]): Line => ({
  text, payment: readBankLine(text)!, paidOn: readBankDate(text), candidates: matches.map(candidate), exact: false,
})
const today = "2026-10-20"
const card = (lines: Line[], { canVoid = true, onDismiss = () => {} } = {}) =>
  render(<I18nProvider locale="da-DK"><BankCard lines={lines} today={today} canVoid={canVoid} onDismiss={onDismiss} /></I18nProvider>)
const confirm = (count: number) => act(async () => { fireEvent.click(screen.getByRole("button", { name: `Markér ${count} som betalt` })) })

describe("BankCard", () => {
  const lines = [
    line("Birk Arkitekter INV-1 100,00", invoice("a", "INV-1", "Birk Arkitekter")),
    line("Studio Vester INV-2 100,00", invoice("b", "INV-2", "Studio Vester")),
    line("Ukendt indbetaling 55,00", null),
  ]

  it("ticks every matched line, records only the ticked ones, and can undo them", async () => {
    api.record.mockImplementation(async ({ invoiceId }: { invoiceId: string }) => ({ payment: { id: `pay-${invoiceId}` } }))
    api.void.mockResolvedValue({})
    card(lines)
    expect(screen.getByText("Ingen faktura fundet")).toBeTruthy()
    fireEvent.click(screen.getByRole("checkbox", { name: "Studio Vester INV-2 100,00" }))
    await confirm(1)

    expect(api.record).toHaveBeenCalledTimes(1)
    expect(api.record.mock.calls[0]![0]).toMatchObject({ invoiceId: "a", amount: 100, method: "bank_transfer", paidAt: today })
    expect(screen.getByText("1 betalinger registreret")).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fortryd" })) })
    expect(api.void).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "pay-a" }))
    expect(screen.getByText("Fortrudt")).toBeTruthy()
  })

  it("records a payment on the day the bank booked it", async () => {
    api.record.mockResolvedValue({ payment: { id: "pay" } })
    card([line("16.10.2026 Birk Arkitekter INV-1 100,00", invoice("a", "INV-1", "Birk Arkitekter"))])
    await confirm(1)
    expect(api.record.mock.calls[0]![0]).toMatchObject({ paidAt: "2026-10-16" })
  })

  it("leaves a line that could pay more than one invoice unticked until the user picks one", async () => {
    api.record.mockResolvedValue({ payment: { id: "pay" } })
    card([shortlist("Birk 100,00", [invoice("a", "INV-1", "Birk Arkitekter"), invoice("b", "INV-2", "Birk Arkitekter")])])
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole("button", { name: "Markér 0 som betalt" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole("combobox", { name: "Vælg faktura for Birk" }), { target: { value: "b" } })
    await confirm(1)
    expect(api.record.mock.calls[0]![0]).toMatchObject({ invoiceId: "b" })
  })

  it("keeps the card when a line fails, and finishes the rest without recording a line twice", async () => {
    api.record.mockResolvedValueOnce({ payment: { id: "pay-a" } }).mockRejectedValueOnce(new Error("paid already"))
    card(lines)
    await confirm(2)
    expect(screen.getByRole("alert").textContent).toBe("Betalingen blev ikke registreret.")
    expect(screen.getByText("Registreret")).toBeTruthy()

    api.record.mockResolvedValueOnce({ payment: { id: "pay-b" } })
    await confirm(1)
    expect(api.record).toHaveBeenCalledTimes(3)
    expect(api.record.mock.calls[2]![0]).toMatchObject({ invoiceId: "b", requestId: api.record.mock.calls[1]![0].requestId })
    expect(screen.getByText("2 betalinger registreret")).toBeTruthy()
  })

  it("says so when an undo fails, and offers no undo without the right to void", async () => {
    api.record.mockResolvedValue({ payment: { id: "pay-a" } })
    api.void.mockRejectedValue(new Error("forbidden"))
    card([lines[0]!])
    await confirm(1)
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fortryd" })) })
    expect(screen.queryByText("Fortrudt")).toBeNull()
    expect(screen.getByRole("alert").textContent).toBe("Betalingen kunne ikke fortrydes.")
    cleanup()

    card([lines[0]!], { canVoid: false })
    await confirm(1)
    expect(screen.queryByRole("button", { name: "Fortryd" })).toBeNull()
  })

  it("cannot be dismissed while it is recording", async () => {
    let finish: (value: unknown) => void = () => {}
    api.record.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const onDismiss = vi.fn()
    card([lines[0]!], { onDismiss })
    await confirm(1)
    const dismiss = screen.getByRole("button", { name: "Annuller" }) as HTMLButtonElement
    expect(dismiss.disabled).toBe(true)
    await act(async () => { finish({ payment: { id: "pay-a" } }) })
  })
})
