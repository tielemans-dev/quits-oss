// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { formatCurrency } from "../../../../lib/i18n/format"
import { I18nProvider } from "../../../../lib/i18n/react"
import { translate } from "../../../../lib/i18n/translate"
// MOCK: transport only; the dialog and its validation are real.
const { record, refund, voidRefund } = vi.hoisted(() => ({ record: vi.fn(), refund: vi.fn(), voidRefund: vi.fn() }))
vi.mock("../../../../trpc/client", () => ({
  trpc: { payments: { record: { mutate: record }, void: { mutate: record }, refund: { mutate: refund }, voidRefund: { mutate: voidRefund } } },
}))
import { RecordPaymentDialog, VoidPaymentDialog } from "../payments-panel"
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe.each(["da-DK", "en-GB"])("record payment validation in %s (QUI-39)", (locale) => {
  function open() {
    render(<I18nProvider locale={locale}><RecordPaymentDialog invoiceId="inv" invoiceNumber="F-1" currency="DKK" balanceDue={100} timeZone="Europe/Copenhagen" onClose={() => {}} onRecorded={async () => {}} /></I18nProvider>)
    const amount = screen.getByLabelText(translate("payments.record.amount", locale, { currency: "DKK" }))
    return { amount, form: amount.closest("form")! }
  }

  it.each(["", "0.000000005", "5e-9"])("shows the app's message for amount %j instead of the browser's tooltip", (value) => {
    const { amount, form } = open()
    expect(form.noValidate).toBe(true)
    fireEvent.change(amount, { target: { value } })
    fireEvent.submit(form)
    expect(screen.getByText(translate("payments.record.error.amount", locale))).toBeTruthy()
    expect(record).not.toHaveBeenCalled()
  })

  it("clears the amount message once the amount changes", () => {
    const { amount, form } = open()
    fireEvent.change(amount, { target: { value: "" } })
    fireEvent.submit(form)
    const message = translate("payments.record.error.amount", locale)
    expect(screen.getByText(message)).toBeTruthy()
    fireEvent.change(amount, { target: { value: "50" } })
    expect(screen.queryByText(message)).toBeNull()
  })
})

describe.each(["da-DK", "en-GB"])("void payment validation in %s (QUI-39)", (locale) => {
  it("shows the app's message for an empty reason and clears it once the reason is edited", () => {
    render(<I18nProvider locale={locale}><VoidPaymentDialog payment={{ id: "p1", amount: 100, currency: "DKK" } as never} locale={locale} onClose={() => {}} onVoided={async () => {}} /></I18nProvider>)
    const reason = screen.getByLabelText(translate("payments.void.reason", locale))
    const form = reason.closest("form")!
    expect(form.noValidate).toBe(true)
    fireEvent.submit(form)
    const message = translate("payments.void.error.reason", locale)
    expect(screen.getByText(message)).toBeTruthy()
    expect(record).not.toHaveBeenCalled()
    fireEvent.change(reason, { target: { value: "Entered twice" } })
    expect(screen.queryByText(message)).toBeNull()
  })
})

describe.each(["da-DK", "en-GB"])("refund to the customer in %s (QUI-228)", (locale) => {
  it("asks for amount, date and note, refuses more than is owed, and retries under the same request ID", async () => {
    render(<I18nProvider locale={locale}><RecordPaymentDialog refund invoiceId="inv" invoiceNumber="F-1" currency="DKK" balanceDue={400} timeZone="Europe/Copenhagen" locale={locale} onClose={() => {}} onRecorded={async () => {}} /></I18nProvider>)
    expect(screen.queryByRole("combobox")).toBeNull()
    const amount = screen.getByLabelText(translate("payments.record.amount", locale, { currency: "DKK" }))
    const form = amount.closest("form")!
    fireEvent.change(amount, { target: { value: "400.01" } })
    fireEvent.submit(form)
    expect(screen.getByRole("alert").textContent).toBe(translate("payments.refund.error.exceedsOwed", locale, { owed: formatCurrency(400, "DKK", locale) }))
    expect(refund).not.toHaveBeenCalled()

    fireEvent.change(amount, { target: { value: "150" } })
    refund.mockRejectedValueOnce(new Error("Network error"))
    fireEvent.submit(form)
    await screen.findByText("Network error")
    fireEvent.submit(form)
    await waitFor(() => expect(refund).toHaveBeenCalledTimes(2))
    const [first, retry] = refund.mock.calls.map(([input]) => input)
    expect(first).toEqual({ invoiceId: "inv", amount: 150, note: undefined, requestId: expect.any(String), refundedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    expect(retry.requestId).toBe(first.requestId)
  })

  it("voids a refund through its own command", async () => {
    render(<I18nProvider locale={locale}><VoidPaymentDialog refund payment={{ id: "r1", amount: 150, currency: "DKK" }} locale={locale} onClose={() => {}} onVoided={async () => {}} /></I18nProvider>)
    expect(screen.getByText(translate("payments.refund.void.title", locale))).toBeTruthy()
    fireEvent.change(screen.getByLabelText(translate("payments.void.reason", locale)), { target: { value: "Bounced" } })
    fireEvent.submit(screen.getByLabelText(translate("payments.void.reason", locale)).closest("form")!)
    await waitFor(() => expect(voidRefund).toHaveBeenCalledWith({ refundId: "r1", reason: "Bounced" }))
    expect(record).not.toHaveBeenCalled()
  })
})
