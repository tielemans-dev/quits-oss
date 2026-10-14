// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { I18nProvider } from "../../lib/i18n/react"
import { useFirstInvoiceBankNudge } from "./bank-nudge"
const { readiness, sent } = vi.hoisted(() => ({ readiness: vi.fn(), sent: vi.fn() }))
vi.mock("../../trpc/client", () => ({
  trpc: { paymentDetails: { firstSendReadiness: { query: readiness } } },
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))
function Sender() {
  const nudge = useFirstInvoiceBankNudge()
  return (
    <>
      <button
        onClick={async () => {
          if (await nudge.beforeSend()) sent()
        }}
      >
        Send invoice
      </button>
      {nudge.dialog}
    </>
  )
}
beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)
it("asks before sending, then sends only after an explicit skip", async () => {
  readiness.mockResolvedValue({ bankMissing: true })
  render(
    <I18nProvider locale="da-DK">
      <Sender />
    </I18nProvider>,
  )
  fireEvent.click(screen.getByText("Send invoice"))
  await screen.findByRole("dialog")
  expect(sent).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText("Send uden bankkonto"))
  await waitFor(() => expect(sent).toHaveBeenCalledOnce())
})
it("dismissal keeps the invoice unsent", async () => {
  readiness.mockResolvedValue({ bankMissing: true })
  render(
    <I18nProvider locale="en-GB">
      <Sender />
    </I18nProvider>,
  )
  fireEvent.click(screen.getByText("Send invoice"))
  const dialog = await screen.findByRole("dialog")
  fireEvent.keyDown(dialog, { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(sent).not.toHaveBeenCalled()
})
it("does not interrupt an organization with payment details or an issued invoice", async () => {
  readiness.mockResolvedValue({ bankMissing: false })
  render(
    <I18nProvider>
      <Sender />
    </I18nProvider>,
  )
  fireEvent.click(screen.getByText("Send invoice"))
  await waitFor(() => expect(sent).toHaveBeenCalledOnce())
  expect(screen.queryByRole("dialog")).toBeNull()
})
