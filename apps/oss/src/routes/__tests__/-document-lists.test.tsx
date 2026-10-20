// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  locale: "en-US",
  invoices: vi.fn(),
  settings: vi.fn(),
  quotes: vi.fn(),
  creditNotes: vi.fn(),
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options }),
  Link: ({ children, to, params: _params, search: _search, ...props }: Record<string, unknown>) => (
    <a href={String(to)} {...props}>
      {children as never}
    </a>
  ),
  useNavigate: () => vi.fn(),
}))

vi.mock("../../trpc/client", () => ({
  trpc: {
    dashboard: { summary: { query: vi.fn().mockResolvedValue(null) } },
    invoices: { list: { query: state.invoices }, markOverdue: { mutate: vi.fn() } },
    settings: { get: { query: state.settings } },
    quotes: { list: { query: state.quotes } },
    creditNotes: { list: { query: state.creditNotes } },
  },
}))

vi.mock("../../lib/i18n/react", async () => {
  const { translate } = await import("../../lib/i18n/translate")
  return {
    useI18n: () => ({
      locale: state.locale,
      t: (key: Parameters<typeof translate>[0], vars?: Record<string, string | number>) =>
        translate(key, state.locale, vars),
    }),
  }
})

import { notifyMutation } from "../../lib/query-refresh"
import { Route as InvoicesRoute } from "../_app/invoices/index"
import { Route as QuotesRoute } from "../_app/quotes/index"
import { Route as CreditNotesRoute } from "../_app/credit-notes/index"

const show = (route: unknown) => {
  const Page = (route as { component: ComponentType }).component
  return render(<Page />)
}

const common = { currency: "DKK", contact: { name: "Acme" }, issueDate: "2026-10-01", total: 100 }

beforeEach(() => {
  state.locale = "en-US"
  state.settings.mockReset().mockResolvedValue({ timezone: "Europe/Copenhagen" })
  state.invoices.mockResolvedValue([
    { ...common, id: "i1", number: "1042", status: "sent", paymentStatus: "unpaid", dueDate: "2026-10-31", balanceDue: 100 },
    { ...common, id: "i2", number: "1043", status: "sent", paymentStatus: "unpaid", dueDate: "2026-10-31", balanceDue: 100 },
    { ...common, id: "i3", number: null, status: "draft", paymentStatus: "unpaid", dueDate: "2026-10-31", balanceDue: 100 },
  ])
  state.quotes.mockResolvedValue([
    { ...common, id: "q1", number: "T-7", status: "sent", expiryDate: "2026-10-31" },
    { ...common, id: "q2", number: null, status: "draft", expiryDate: "2026-10-31" },
  ])
  state.creditNotes.mockResolvedValue([
    { ...common, id: "c1", number: "KN-1", status: "issued", reason: "x", invoice: { number: "1042" } },
    { ...common, id: "c2", number: "KN-2", status: "issued", reason: "x", invoice: { number: "1043" } },
  ])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Every row has as many cells as the header has column headers, so the table is valid ARIA. */
function expectConsistentTable(table: HTMLElement) {
  const headers = within(table).getAllByRole("columnheader", { hidden: true })
  const rows = within(table).getAllByRole("row", { hidden: true }).slice(1)
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    expect(within(row).getAllByRole("cell", { hidden: true })).toHaveLength(headers.length)
  }
}

describe("invoice list", () => {
  it.each([
    ["en-US", false, "Overdue", "Overdue"],
    ["da-DK", false, "Forfalden", "Forfalden"],
    ["en-US", true, "Sent", "Overdue"],
    ["da-DK", true, "Sendt", "Forfalden"],
  ])("renders invoices in %s with settings failure=%s at the due-day boundary", async (locale, settingsFail, dueTodayLabel, pastDueLabel) => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-11T23:00:00Z"))
    state.locale = locale
    if (settingsFail) state.settings.mockRejectedValue(new Error("Settings unavailable"))
    state.invoices.mockResolvedValue([
      { ...common, id: "i1", number: "1042", status: "sent", paymentStatus: "unpaid", dueDate: "2026-10-11", balanceDue: 100 },
      { ...common, id: "i2", number: "1043", status: "sent", paymentStatus: "unpaid", dueDate: "2026-10-10", balanceDue: 100 },
    ])

    show(InvoicesRoute)
    const table = await screen.findByRole("table", { name: locale === "da-DK" ? "Fakturaer" : "Invoices" })
    const rows = within(table).getAllByRole("row").slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByRole("link", { name: locale === "da-DK" ? "Faktura 1042, Acme" : "Invoice 1042, Acme" })).toBeTruthy()
    expect(within(rows[0]).getByText(dueTodayLabel).dataset.tone).toBe(settingsFail ? "info" : "warning")
    expect(within(rows[1]).getByText(pastDueLabel).dataset.tone).toBe("warning")
    expect(state.settings).toHaveBeenCalledTimes(1)
  })

  it.each([["en-US", "Sent", "Overdue"], ["da-DK", "Sendt", "Forfalden"]])(
    "uses the balance to distinguish past-due invoice labels in %s",
    async (locale, sentLabel, overdueLabel) => {
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date("2026-10-12T10:00:00Z"))
      state.locale = locale
      state.invoices.mockResolvedValue([
        { ...common, id: "zero", number: "1042", total: 0, status: "sent", paymentStatus: "unpaid", dueDate: "2026-10-11", balanceDue: 0 },
        { ...common, id: "positive", number: "1043", status: "sent", paymentStatus: "unpaid", dueDate: "2026-10-11", balanceDue: 0.01 },
        { ...common, id: "credited", number: "1044", status: "sent", paymentStatus: "unpaid", dueDate: "2026-10-11", balanceDue: 0 },
      ])

      show(InvoicesRoute)
      const table = await screen.findByRole("table", { name: locale === "da-DK" ? "Fakturaer" : "Invoices" })
      const rows = within(table).getAllByRole("row").slice(1)
      expect(rows).toHaveLength(3)
      expect(within(rows[0]).getByText(sentLabel).dataset.tone).toBe("info")
      expect(within(rows[1]).getByText(overdueLabel).dataset.tone).toBe("warning")
      expect(within(rows[2]).getByText(sentLabel).dataset.tone).toBe("info")
    }
  )

  it("names each row link with the document, so one customer's invoices differ", async () => {
    show(InvoicesRoute)
    await screen.findByRole("link", { name: "Invoice 1042, Acme" })
    expect(screen.getByRole("link", { name: "Invoice 1043, Acme" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Draft invoice, Acme" })).toBeTruthy()
  })

  it("names the links in Danish", async () => {
    state.locale = "da-DK"
    show(InvoicesRoute)
    await screen.findByRole("link", { name: "Faktura 1042, Acme" })
    expect(screen.getByRole("link", { name: "Fakturakladde, Acme" })).toBeTruthy()
  })

  it("keeps the header in the accessibility tree on a narrow list, and the cell counts valid", async () => {
    show(InvoicesRoute)
    const table = await screen.findByRole("table", { name: "Invoices" })
    const headerRow = within(table).getAllByRole("row", { hidden: true })[0]
    // Visually hidden below 56rem, never display:none.
    expect(headerRow.className).toContain("@max-4xl:sr-only")
    expect(headerRow.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    expectConsistentTable(table)
  })
})

describe("quote list", () => {
  it("names each row link with the document", async () => {
    show(QuotesRoute)
    await screen.findByRole("link", { name: "Quote T-7, Acme" })
    expect(screen.getByRole("link", { name: "Draft quote, Acme" })).toBeTruthy()
    expectConsistentTable(screen.getByRole("table", { name: "Quotes" }))
  })

  it("names the links in Danish", async () => {
    state.locale = "da-DK"
    show(QuotesRoute)
    await screen.findByRole("link", { name: "Tilbud T-7, Acme" })
    expect(screen.getByRole("link", { name: "Tilbudskladde, Acme" })).toBeTruthy()
  })
})

describe("credit note list", () => {
  it("names each row link with the document", async () => {
    show(CreditNotesRoute)
    await screen.findByRole("link", { name: "Credit note KN-1, Acme" })
    expect(screen.getByRole("link", { name: "Credit note KN-2, Acme" })).toBeTruthy()
    await waitFor(() => expectConsistentTable(screen.getByRole("table", { name: "Credit notes" })))
  })

  it("names the links in Danish", async () => {
    state.locale = "da-DK"
    show(CreditNotesRoute)
    await screen.findByRole("link", { name: "Kreditnota KN-1, Acme" })
  })
})

describe('failed list queries', () => {
  it('keeps a failed refresh visible until retry succeeds', async () => {
    show(InvoicesRoute)
    await screen.findByRole('link', {name:'Invoice 1042, Acme'})
    state.invoices.mockRejectedValueOnce(new Error('Refresh failed'))
    await act(async () => notifyMutation('invoices.updateV2', null))
    await screen.findByText('Refresh failed')
    let finish!: (value: never[]) => void
    state.invoices.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', {name:'Try again'}))
    expect(screen.getByRole('alert').textContent).toContain('Refresh failed')
    await act(async () => finish([]))
  })
  it.each([
    ['invoices', InvoicesRoute, state.invoices, /no invoices/i],
    ['quotes', QuotesRoute, state.quotes, /no quotes/i],
    ['credit notes', CreditNotesRoute, state.creditNotes, /no credit notes/i],
  ])('shows a retry instead of an empty %s list', async (_name, route, query, empty) => {
    query.mockRejectedValueOnce(new Error('Data service unavailable'))
    show(route)
    expect((await screen.findByRole('alert')).textContent).toContain('Data service unavailable')
    expect(screen.queryByText(empty)).toBeNull()
    query.mockResolvedValue([])
    fireEvent.click(screen.getByRole('button', {name:'Try again'}))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText(empty)).toBeTruthy()
  })
})
