// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ list: vi.fn(), settings: vi.fn(), readiness: vi.fn(), jobs: vi.fn(), open: vi.fn() }))
vi.mock("../../../trpc/client", () => ({
  trpc: {
    invoices: { list: { query: api.list }, sendReadiness: { query: api.readiness } },
    settings: { get: { query: api.settings } },
  },
}))
vi.mock("../../jobs/reminder-jobs-store", () => ({ useReminderJobs: api.jobs }))
vi.mock("@tanstack/react-router", () => ({ Link: ({ to, children }: { to: string; children: unknown }) => <a href={to}>{children as never}</a> }))

import { I18nProvider } from "../../../lib/i18n/react"
import { announceRequestDone, onRequestOpen } from "../../command-bar/request-events"
import { MorningCard } from "../morning-card"

const invoice = (id: string, extra: Record<string, unknown> = {}) => ({
  id, number: `F-${id}`, status: "sent", paymentStatus: "unpaid", dueDate: "2020-01-10T00:00:00.000Z",
  balanceDue: 1000, total: 1000, currency: "DKK", contact: { name: `Kunde ${id}` }, contactId: `c${id}`, ...extra,
})
const text = () => (document.body.textContent ?? "").replace(/[  ]/g, " ")
const renderCard = (canSendReminders = true) =>
  render(<I18nProvider locale="da-DK"><MorningCard canSendReminders={canSendReminders} /></I18nProvider>)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-14T08:00:00Z") })
  api.jobs.mockReturnValue([])
  api.settings.mockResolvedValue({ timezone: "Europe/Copenhagen", countryCode: "DK", taxRegime: "eu_vat", momsRegistered: true, vatPeriod: "quarterly" })
  api.readiness.mockResolvedValue({ issues: [], policyUnavailable: false, recipientVersion: "v1" })
  api.list.mockResolvedValue([
    invoice("1", { balanceDue: 1250.5 }),
    invoice("2", { dueDate: "2020-02-10T00:00:00.000Z", balanceDue: 750 }),
    invoice("3", { status: "draft", total: 10750 }),
    invoice("4", { status: "paid", paymentStatus: "paid", balanceDue: 0 }),
  ])
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe("morning card", () => {
  it("shows the overdue count and amount, the ready drafts and the moms deadline, and sends nothing", async () => {
    renderCard()
    await screen.findByTestId("morning-card")

    expect(text()).toContain("2 forfaldne")
    expect(text()).toContain("2.000,50 kr.")
    expect(text()).toContain("1 kladde klar til at sende")
    expect(text()).toContain("Kunde 3 · 10.750,00 kr.")
    expect(text()).toContain("Moms for Q3 skal indberettes om 48 dage")
    expect(text()).toContain("Frist 1. dec. 2026")
    expect(api.readiness).toHaveBeenCalledWith({ contactId: "c3", currency: "DKK" })
    // Read-only calls only: there is no mutation on the client to call.
  })

  it("opens the overdue card from its one action, and the drafts action goes to the list", async () => {
    const opened = vi.fn()
    onRequestOpen(opened)
    renderCard()
    fireEvent.click(await screen.findByRole("button", { name: "Send rykker til 2" }))

    expect(opened).toHaveBeenCalledWith({ kind: "overdue", input: "Forfaldne fakturaer" })
    expect(screen.getByRole("link", { name: "Gennemgå kladder" }).getAttribute("href")).toBe("/invoices")
  })

  it("offers no reminder action to someone who may not send", async () => {
    renderCard(false)
    await screen.findByTestId("morning-card")

    expect(screen.queryByRole("button", { name: /Send rykker/ })).toBeNull()
  })

  it("keeps a draft out when its customer cannot be sent to", async () => {
    api.readiness.mockResolvedValue({ issues: [{ code: "customer.email.required" }], policyUnavailable: false, recipientVersion: null })
    renderCard()
    await screen.findByTestId("morning-card")

    expect(text()).toContain("Ingen kladder klar til at sende")
  })

  it("states an empty row while another row has something, and hides when nothing needs doing", async () => {
    api.list.mockResolvedValue([invoice("4", { status: "paid", paymentStatus: "paid", balanceDue: 0 })])
    renderCard()
    await screen.findByTestId("morning-card")
    expect(text()).toContain("Ingen forfaldne fakturaer")

    cleanup()
    api.settings.mockResolvedValue({ timezone: "Europe/Copenhagen", countryCode: "DK", taxRegime: "eu_vat", momsRegistered: true, vatPeriod: null })
    renderCard()
    await waitFor(() => expect(api.settings).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.queryByTestId("morning-card")).toBeNull()
  })

  it("reloads its figures when an invoice is sent from the command bar", async () => {
    renderCard()
    await screen.findByTestId("morning-card")
    api.list.mockResolvedValue([invoice("1", { balanceDue: 1250.5 })])
    await act(async () => announceRequestDone({ kind: "invoice", invoiceId: "new" }))

    await waitFor(() => expect(text()).toContain("1 forfalden"))
  })
})
