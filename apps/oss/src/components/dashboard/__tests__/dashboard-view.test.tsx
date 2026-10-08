// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    className,
    ...props
  }: {
    children?: unknown
    to: string
    params?: Record<string, string>
    className?: string
    "aria-label"?: string
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)}
      className={className}
      aria-label={props["aria-label"]}
    >
      {children as never}
    </a>
  ),
}))

import { I18nProvider } from "../../../lib/i18n/react"
import { DashboardView } from "../dashboard-view"
import type { Summary } from "../summary-model"
import { activeSummary, bucket, emptySummary, emptyTotal, MONTHS, total } from "./fixtures"

afterEach(cleanup)

function renderView(
  summary: Summary,
  sendReminder: (invoiceId: string) => Promise<{ delivery: string }> = async () => ({ delivery: "sent" }),
  onSettled?: () => void
) {
  return render(
    <I18nProvider locale="da-DK">
      <DashboardView summary={summary} sendReminder={sendReminder} onRemindersSettled={onSettled} />
    </I18nProvider>
  )
}

describe("first run", () => {
  it("shows no figures at all, and one clear action", () => {
    const { container } = renderView(emptySummary())
    expect(container.querySelector("[data-slot=dashboard-first-run]")).not.toBeNull()
    expect(container.querySelector("[data-slot=dashboard-hero]")).toBeNull()
    expect(container.querySelector("[data-slot=amount]")).toBeNull()
    expect(container.textContent).not.toMatch(/0,00/)
    expect(screen.getByRole("link", { name: "Opret din første faktura" }).getAttribute("href")).toBe("/invoices/new")
    expect(screen.getByRole("link", { name: "Tilføj en kunde" }).getAttribute("href")).toBe("/contacts/new")
  })
})

describe("getting started", () => {
  it("shows a next step instead of a zero, and the events that exist", () => {
    const summary = emptySummary({
      activity: [
        { id: "e1", sequence: 1, type: "invoice.draft_created", aggregateType: "invoice", aggregateId: "a", occurredAt: "2026-10-07T10:00:00.000Z" },
        { id: "e2", sequence: 2, type: "invoice.draft_created", aggregateType: "invoice", aggregateId: "b", occurredAt: "2026-10-07T11:00:00.000Z" },
      ],
    })
    const { container } = renderView(summary)
    expect(container.querySelector("[data-slot=dashboard-getting-started]")).not.toBeNull()
    expect(container.querySelector("[data-slot=dashboard-hero]")).toBeNull()
    expect(container.querySelector("[data-slot=amount]")).toBeNull()
    expect(screen.getByText("2 fakturakladder oprettet")).toBeTruthy()
  })
})

describe("with money", () => {
  it("shows the base currency figure, and another currency as a quiet line", () => {
    const { container } = renderView(activeSummary())
    const hero = container.querySelector("[data-slot=dashboard-hero]")!
    expect(hero.querySelector("[data-slot=amount]")!.textContent).toBe("20.000,00\u00a0kr.")
    expect(hero.textContent).toContain("1.800,00\u00a0€ udestående")
    // No sum across currencies anywhere on the page.
    expect(container.textContent).not.toContain("21.800")
    expect(hero.querySelector("[data-slot=amount]")!.getAttribute("data-rule")).toBe("single")
  })

  it("says the overdue amount, the count and the age as a quiet second line", () => {
    renderView(activeSummary())
    expect(screen.getByText(/8\.750,00\skr\. forfaldent · 1 faktura/)).toBeTruthy()
    expect(screen.getByText(/Den ældste er 14 dage over tid/)).toBeTruthy()
  })

  it("draws the second rule and says so when nothing is owed", () => {
    const summary = activeSummary({
      outstanding: emptyTotal(),
      overdue: { ...emptyTotal(), oldestDaysOverdue: 0 },
      incoming: [],
      attention: [],
    })
    const { container } = renderView(summary)
    expect(container.querySelector("[data-slot=dashboard-hero] [data-slot=amount]")!.getAttribute("data-rule")).toBe("double")
    expect(screen.getAllByText("Alt er betalt. Du er kvit.").length).toBeGreaterThan(0)
  })

  it("shows the streak from two, and hides it below", () => {
    renderView(activeSummary({ streak: 12 }))
    expect(screen.getByText("12 fakturaer betalt til tiden i træk")).toBeTruthy()
    cleanup()
    renderView(activeSummary({ streak: 1 }))
    expect(screen.queryByText(/betalt til tiden i træk/)).toBeNull()
  })

  it("draws one bar per month and marks the current month", () => {
    const { container } = renderView(activeSummary())
    expect(container.querySelectorAll("[data-month]")).toHaveLength(12)
    expect(container.querySelectorAll("[data-current]")).toHaveLength(1)
    expect(container.querySelector("[data-month='2026-10']")!.getAttribute("aria-label")).toBe("oktober 2026: 10.000,00\u00a0kr.")
    expect(screen.getByText("Betalinger i andre valutaer vises ikke her.")).toBeTruthy()
  })

  it("says when nobody has paid in the base currency, rather than drawing zeros", () => {
    const summary = activeSummary({
      receivedByMonth: MONTHS.map((month) => ({ month, ...emptyTotal() })),
      paidThisMonth: emptyTotal(),
    })
    renderView(summary)
    expect(screen.getByText("Der er ikke modtaget betalinger i DKK endnu.")).toBeTruthy()
  })

  it("shows a calm line when nothing needs attention", () => {
    renderView(activeSummary({ attention: [] }))
    expect(screen.getByText("Intet kræver din opmærksomhed. Godt gået.")).toBeTruthy()
  })
})

describe("incoming list", () => {
  it("shows how late or how soon each invoice is, with its amount on a single rule", () => {
    const { container } = renderView(activeSummary())
    const incoming = container.querySelector("[data-slot=dashboard-incoming]") as HTMLElement
    expect(within(incoming).getByText("14 dage over tid")).toBeTruthy()
    expect(within(incoming).getByText("Forfalder om 3 dage")).toBeTruthy()
    const rules = Array.from(incoming.querySelectorAll("[data-slot=amount]")).map((el) => el.getAttribute("data-rule"))
    expect(rules).toEqual(["single", "single"])
  })

  it("does not offer a second reminder for what the attention list already offers", () => {
    const { container } = renderView(activeSummary())
    const incoming = container.querySelector("[data-slot=dashboard-incoming]") as HTMLElement
    expect(within(incoming).queryByRole("button", { name: "Send påmindelse" })).toBeNull()
  })
})

describe("attention reasons and actions", () => {
  const reasons: Array<[Summary["attention"][number]["reason"], string, string]> = [
    ["invoice_overdue", "Faktura 2026-9 er forfalden", "Åbn faktura"],
    ["draft_older_than_7_days", "Fakturakladde, der ikke er sendt", "Åbn kladde"],
    ["quote_expiring", "Tilbud 2026-9 udløber snart", "Følg op"],
    ["email_failed", "E-mailen med faktura 2026-9 blev ikke leveret", "Se levering"],
    ["email_unconfirmed", "Levering af faktura 2026-9 er ikke bekræftet", "Se levering"],
  ]

  it.each(reasons)("%s says why and offers one action that opens the document", (reason, sentence, action) => {
    const summary = emptySummary({
      outstanding: total(bucket("DKK", "100.00")),
      attention: [
        {
          documentId: "doc-1",
          number: "2026-9",
          customerName: "Kunde",
          amount: { currency: "DKK", amount: "100.00", exponent: 2 },
          kind: reason === "quote_expiring" ? "quote" : "invoice",
          reason,
          canRemind: false,
        },
      ],
    })
    renderView(summary)
    expect(screen.getByText(sentence)).toBeTruthy()
    const link = screen.getAllByRole("link", { name: action })[0]!
    expect(link.getAttribute("href")).toBe(reason === "quote_expiring" ? "/quotes/doc-1" : "/invoices/doc-1")
  })
})

describe("reminder action", () => {
  it("sends the reminder for the invoice, then says it was sent and reloads", async () => {
    const send = vi.fn(async () => ({ delivery: "sent" }))
    const settled = vi.fn()
    renderView(activeSummary(), send, settled)
    fireEvent.click(screen.getByRole("button", { name: "Send påmindelse" }))
    expect(send).toHaveBeenCalledExactlyOnceWith("inv-overdue")
    await waitFor(() => expect(screen.getByText("Påmindelse sendt")).toBeTruthy())
    expect(screen.queryByRole("button", { name: "Send påmindelse" })).toBeNull()
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it("is disabled while sending and cannot be sent twice", async () => {
    let finish!: (value: { delivery: string }) => void
    const send = vi.fn(() => new Promise<{ delivery: string }>((resolve) => (finish = resolve)))
    renderView(activeSummary(), send)
    fireEvent.click(screen.getByRole("button", { name: "Send påmindelse" }))
    const sending = await screen.findByRole("button", { name: "Sender..." })
    expect((sending as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(sending)
    expect(send).toHaveBeenCalledTimes(1)
    finish({ delivery: "sent" })
    await waitFor(() => expect(screen.getByText("Påmindelse sendt")).toBeTruthy())
  })

  it("shows the server's refusal and lets the person try again", async () => {
    const send = vi.fn(async () => {
      throw new Error("Der er allerede sendt en påmindelse i dag")
    })
    const settled = vi.fn()
    renderView(activeSummary(), send, settled)
    fireEvent.click(screen.getByRole("button", { name: "Send påmindelse" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Der er allerede sendt en påmindelse i dag"))
    expect(screen.getByRole("button", { name: "Send påmindelse" })).toBeTruthy()
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it("falls back to a plain message when the refusal has none", async () => {
    renderView(activeSummary(), async () => {
      throw "boom"
    })
    fireEvent.click(screen.getByRole("button", { name: "Send påmindelse" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Påmindelsen kunne ikke sendes"))
  })

  it("is not offered where the server says no", () => {
    const summary = activeSummary()
    summary.attention[0] = { ...summary.attention[0]!, canRemind: false }
    summary.incoming[0] = { ...summary.incoming[0]!, canRemind: false }
    renderView(summary)
    expect(screen.queryByRole("button", { name: "Send påmindelse" })).toBeNull()
  })

  it("remembers a sent reminder after the summary reloads without the action", async () => {
    const send = vi.fn(async () => ({ delivery: "unconfirmed" }))
    const view = renderView(activeSummary(), send)
    fireEvent.click(screen.getByRole("button", { name: "Send påmindelse" }))
    await waitFor(() => expect(screen.getByText("Levering ikke bekræftet")).toBeTruthy())
    // The server stops offering the action once today's reminder exists.
    const reloaded = activeSummary()
    reloaded.attention[0] = { ...reloaded.attention[0]!, canRemind: false }
    view.rerender(
      <I18nProvider locale="da-DK">
        <DashboardView summary={reloaded} sendReminder={send} />
      </I18nProvider>
    )
    expect(screen.queryByRole("button", { name: "Send påmindelse" })).toBeNull()
  })
})
