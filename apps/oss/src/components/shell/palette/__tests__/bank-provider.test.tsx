// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ record: vi.fn(), void: vi.fn() }))
vi.mock("../../../../trpc/client", () => ({ trpc: { payments: { record: { mutate: api.record }, void: { mutate: api.void } } } }))

import { I18nProvider } from "../../../../lib/i18n/react"
import type { MatchInvoice } from "../../../../lib/payments/payment-match"
import { BankCard, readBankLine, type Line } from "../bank-provider"

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

const invoice = (id: string, number: string, name: string): MatchInvoice => ({ id, number, status: "sent", paymentStatus: "unpaid", balanceDue: 100, currency: "DKK", contact: { name } })
const line = (text: string, match: MatchInvoice | null): Line => ({
  text, payment: readBankLine(text)!, match: match ? { invoice: match, shortMinor: 0, byReference: true, nameScore: 1 } : null,
})

describe("BankCard", () => {
  const lines = [
    line("Birk Arkitekter INV-1 100,00", invoice("a", "INV-1", "Birk Arkitekter")),
    line("Studio Vester INV-2 100,00", invoice("b", "INV-2", "Studio Vester")),
    line("Ukendt indbetaling 55,00", null),
  ]
  const card = () => render(<I18nProvider locale="da-DK"><BankCard lines={lines} onDismiss={() => {}} /></I18nProvider>)

  it("ticks every matched line, records only the ticked ones, and can undo them", async () => {
    api.record.mockImplementation(async ({ invoiceId }: { invoiceId: string }) => ({ payment: { id: `pay-${invoiceId}` } }))
    api.void.mockResolvedValue({})
    card()
    expect(screen.getByText("Ingen faktura fundet")).toBeTruthy()
    fireEvent.click(screen.getByRole("checkbox", { name: "Studio Vester INV-2 100,00" }))
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Markér 1 som betalt/ })) })

    expect(api.record).toHaveBeenCalledTimes(1)
    expect(api.record.mock.calls[0]![0]).toMatchObject({ invoiceId: "a", amount: 100, method: "bank_transfer" })
    expect(screen.getByText("1 betalinger registreret")).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fortryd" })) })
    expect(api.void).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "pay-a" }))
    expect(screen.getByText("Fortrudt")).toBeTruthy()
  })
})
