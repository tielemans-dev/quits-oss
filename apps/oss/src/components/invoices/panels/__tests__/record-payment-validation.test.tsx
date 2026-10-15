// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { I18nProvider } from "../../../../lib/i18n/react"
import { translate } from "../../../../lib/i18n/translate"
// MOCK: transport only; the dialog and its validation are real.
const record = vi.hoisted(() => vi.fn())
vi.mock("../../../../trpc/client", () => ({ trpc: { payments: { record: { mutate: record }, void: { mutate: record } } } }))
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
