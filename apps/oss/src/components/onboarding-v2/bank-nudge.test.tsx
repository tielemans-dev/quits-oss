// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { I18nProvider } from "../../lib/i18n/react"
import { useFirstInvoiceBankNudge } from "./bank-nudge"
const { readiness, get, update, sent } = vi.hoisted(() => ({ readiness: vi.fn(), get: vi.fn(), update: vi.fn(), sent: vi.fn() }))
vi.mock("../../trpc/client", () => ({
  trpc: { paymentDetails: { firstSendReadiness: { query: readiness }, get: { query: get }, update: { mutate: update } } },
}))
function Sender({ send = async () => sent() }: { send?: () => Promise<void> }) {
  const nudge = useFirstInvoiceBankNudge()
  return (
    <>
      <button
        onClick={async () => {
          if (await nudge.beforeSend()) await send()
          nudge.settled()
        }}
      >
        Send invoice
      </button>
      {nudge.dialog}
    </>
  )
}
function renderDa(send?: () => Promise<void>) {
  render(
    <I18nProvider locale="da-DK">
      <Sender send={send} />
    </I18nProvider>,
  )
}
async function openNudge() {
  fireEvent.click(screen.getByText("Send invoice"))
  await screen.findByRole("dialog")
}
function typeBank(reg: string, account: string) {
  fireEvent.change(screen.getByLabelText("Reg.nr."), { target: { value: reg } })
  fireEvent.change(screen.getByLabelText("Kontonr."), { target: { value: account } })
}
beforeEach(() => {
  vi.resetAllMocks()
  readiness.mockResolvedValue({ bankMissing: true, onlinePayments: false, canSave: true })
  get.mockResolvedValue({ bankAccount: null, note: "MobilePay 12345", canUpdate: true, nextInvoiceNumber: "1" })
  update.mockResolvedValue({})
})
afterEach(cleanup)
it("saves the bank account, keeps the note, then continues the send", async () => {
  let finishSend!: () => void
  renderDa(() => new Promise<void>((resolve) => { finishSend = () => { sent(); resolve() } }))
  await openNudge()
  typeBank("1234", "0012345678")
  fireEvent.click(screen.getByRole("button", { name: "Gem og send" }))
  await screen.findByRole("button", { name: "Sender…" })
  expect(update).toHaveBeenCalledWith({
    bankAccount: { accountHolder: null, bankName: null, regNumber: "1234", accountNumber: "0012345678", iban: null, bic: null },
    note: "MobilePay 12345",
  })
  finishSend()
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(sent).toHaveBeenCalledOnce()
})
it("blocks the send and keeps the typed values when saving fails", async () => {
  let rejectSave!: (error: Error) => void
  update.mockReturnValue(new Promise((_resolve, reject) => { rejectSave = reject }))
  renderDa()
  await openNudge()
  typeBank("1234", "5678")
  fireEvent.click(screen.getByRole("button", { name: "Gem og send" }))
  await screen.findByRole("button", { name: "Gemmer…" })
  rejectSave(new Error("Gemningen fejlede"))
  expect((await screen.findByRole("alert")).textContent).toBe("Gemningen fejlede")
  expect(sent).not.toHaveBeenCalled()
  expect(screen.getByRole("dialog")).toBeTruthy()
  expect((screen.getByLabelText("Reg.nr.") as HTMLInputElement).value).toBe("1234")
  expect((screen.getByLabelText("Kontonr.") as HTMLInputElement).value).toBe("5678")
})
it("shows the shared validation and saves nothing while it fails", async () => {
  renderDa()
  await openNudge()
  typeBank("12", "5678")
  fireEvent.click(screen.getByRole("button", { name: "Gem og send" }))
  expect(await screen.findByText("Angiv præcis 4 cifre.")).toBeTruthy()
  expect(update).not.toHaveBeenCalled()
  expect(sent).not.toHaveBeenCalled()
})
it("warns about sending without an account only when there is no other way to pay", async () => {
  renderDa()
  await openNudge()
  expect(screen.getByText("Din kunde kan ikke se, hvor de skal betale.")).toBeTruthy()
  fireEvent.click(screen.getByText("Send uden bankkonto"))
  await waitFor(() => expect(sent).toHaveBeenCalledOnce())
  cleanup()
  readiness.mockResolvedValue({ bankMissing: true, onlinePayments: true, canSave: true })
  renderDa()
  await openNudge()
  expect(screen.queryByText("Din kunde kan ikke se, hvor de skal betale.")).toBeNull()
  expect(screen.getByText("Send uden bankkonto")).toBeTruthy()
})
it("dismissal keeps the invoice unsent", async () => {
  renderDa()
  await openNudge()
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(sent).not.toHaveBeenCalled()
})
it("does not interrupt an organization with payment details or an issued invoice", async () => {
  readiness.mockResolvedValue({ bankMissing: false })
  renderDa()
  fireEvent.click(screen.getByText("Send invoice"))
  await waitFor(() => expect(sent).toHaveBeenCalledOnce())
  expect(screen.queryByRole("dialog")).toBeNull()
})
