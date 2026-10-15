// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ list: vi.fn(), batch: vi.fn(), jobs: vi.fn(), handoff: vi.fn() }))
vi.mock("../../../trpc/client", () => ({
  trpc: { invoices: { list: { query: api.list } }, settings: { get: { query: async () => ({ timezone: "Europe/Copenhagen" }) } } },
}))
vi.mock("../tracker-handoff", () => ({ handOffToTracker: api.handoff }))
vi.mock("../../jobs/reminder-jobs-store", () => ({ sendReminderBatch: api.batch, useReminderJobs: api.jobs }))

import { I18nProvider } from "../../../lib/i18n/react"
import { OverdueRequestCard } from "../overdue-request-card"

const invoice = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, number: `F-${id}`, status: "overdue", paymentStatus: "unpaid", dueDate: "2020-01-10T00:00:00.000Z",
  balanceDue: 1000, currency: "DKK", contact: { name }, ...extra,
})
const text = () => (document.body.textContent ?? "").replace(/[\u00a0\u202f]/g, " ")

function renderCard(onDismiss = vi.fn()) {
  render(
    <I18nProvider locale="da-DK">
      <OverdueRequestCard intent={{ kind: "overdue", input: "vis forfaldne" }} onDismiss={onDismiss} />
    </I18nProvider>
  )
  return onDismiss
}
const sendButton = (count: number) => screen.findByRole("button", { name: `Send rykker til ${count}` }) as Promise<HTMLButtonElement>

beforeEach(() => {
  api.jobs.mockReturnValue([])
  api.batch.mockResolvedValue({ jobId: "job-1" })
  api.list.mockResolvedValue([
    invoice("1", "Havbrise Logistik A/S", { balanceDue: 1250.5 }),
    invoice("2", "Nordlys ApS", { dueDate: "2020-02-10T00:00:00.000Z", balanceDue: 750 }),
    invoice("3", "Betalt ApS", { status: "paid", paymentStatus: "paid", balanceDue: 0 }),
    invoice("4", "Ikke forfalden ApS", { status: "sent", dueDate: "2099-01-01T00:00:00.000Z" }),
    invoice("5", "Kladde ApS", { status: "draft" }),
  ])
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe("overdue request card", () => {
  it("lists the invoices the list calls overdue, oldest first, with days and the total, and sends nothing by itself", async () => {
    renderCard()
    await sendButton(2)

    expect(text()).toContain("Havbrise Logistik A/S")
    expect(text()).toContain("Nordlys ApS")
    expect(text()).not.toMatch(/Betalt ApS|Ikke forfalden|Kladde/)
    expect(text().indexOf("Havbrise")).toBeLessThan(text().indexOf("Nordlys"))
    expect(text()).toMatch(/\d+ dage over tid/)
    expect(text()).toContain("Udestående i alt2.000,50 kr.")
    expect(api.batch).not.toHaveBeenCalled()
  })

  it("leaves out invoices whose rykker already went out", async () => {
    api.jobs.mockReturnValue([{ id: "j", status: "succeeded", createdAt: new Date(), steps: [{ id: "s", label: "", labelParams: {}, invoiceId: "1", status: "succeeded" }] }])
    renderCard()
    await sendButton(1)

    expect(text()).not.toContain("Havbrise")
  })

  it("hands the ticked rows to the corner tracker and lets go, without sending from the card itself", async () => {
    const onDismiss = renderCard()
    fireEvent.click(await screen.findByRole("checkbox", { name: "Vælg faktura F-1 til Havbrise Logistik A/S" }))
    fireEvent.click(await sendButton(1))

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(api.handoff).toHaveBeenCalledTimes(1)
    expect(api.batch).not.toHaveBeenCalled()
    const [from, send, labels] = api.handoff.mock.calls[0]!
    expect(from).toEqual(expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }))
    expect(labels.retry).toBe("Prøv igen")
    await send()
    expect(api.batch).toHaveBeenCalledWith(["2"], expect.any(String))
  })

  it("sends a retry of the same selection under the same request id", async () => {
    renderCard()
    fireEvent.click(await sendButton(2))

    const [, send] = api.handoff.mock.calls[0]!
    await send()
    await send()
    expect(api.batch).toHaveBeenCalledTimes(2)
    expect(api.batch.mock.calls[1]![1]).toBe(api.batch.mock.calls[0]![1])
    expect(api.batch.mock.calls[0]![0]).toEqual(["1", "2"])
  })

  it("does not hand off twice on a double click", async () => {
    renderCard()
    const button = await sendButton(2)
    fireEvent.click(button)
    fireEvent.click(button)

    expect(api.handoff).toHaveBeenCalledTimes(1)
  })

  it("says so when nothing is overdue", async () => {
    api.list.mockResolvedValue([invoice("4", "Ikke forfalden ApS", { status: "sent", dueDate: "2099-01-01T00:00:00.000Z" })])
    renderCard()

    await screen.findByText("Ingen forfaldne fakturaer.")
    expect(screen.queryByRole("button", { name: /Send rykker/ })).toBeNull()
  })

  it("starts with the first 100 ticked and offers no more", async () => {
    api.list.mockResolvedValue(Array.from({ length: 101 }, (_, i) => invoice(String(i), `Kunde ${i}`)))
    renderCard()
    fireEvent.click(await sendButton(100))

    await api.handoff.mock.calls[0]![1]()
    expect(api.batch.mock.calls[0]![0]).toHaveLength(100)
    expect(text()).toContain("højst sendes 100 rykkere")
  })
})
