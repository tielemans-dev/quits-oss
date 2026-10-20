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
import { activeSummary, activityEvent, bucket, emptySummary, emptyTotal, money, MONTHS, quoteAttention, storageBucket, total, unvaluedOnly } from "./fixtures"

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

describe("greeting and command bar", () => {
  it("greets by first name with the date, and hosts the command bar under it", () => {
    render(
      <I18nProvider locale="da-DK">
        <DashboardView
          summary={activeSummary()}
          sendReminder={async () => ({ delivery: "sent" })}
          userName="Martin Tielemans"
          commandBar={<div data-testid="bar" />}
        />
      </I18nProvider>
    )

    const heading = screen.getByRole("heading", { level: 1 })
    expect(heading.textContent).toBe("God eftermiddag, Martin")
    expect(heading.nextElementSibling?.textContent).toMatch(/^Torsdag 8\. okt\. 2026$/)
    expect(heading.closest("header")?.nextElementSibling?.contains(screen.getByTestId("bar"))).toBe(true)
  })

  it("greets no one by name without one", () => {
    renderView(activeSummary())
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("God eftermiddag")
  })
})

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
      drafts: { count: 2, newestId: "b", newestKind: "invoice" },
      activity: [
        activityEvent({ id: "e2", type: "invoice.draft_created", aggregateId: "b", customerName: "Fjord & Co" }),
        activityEvent({ id: "e1", type: "invoice.draft_created", aggregateId: "a", customerName: "Nordlys ApS" }),
      ],
    })
    const { container } = renderView(summary)
    expect(container.querySelector("[data-slot=dashboard-getting-started]")).not.toBeNull()
    expect(screen.getByRole("heading", { name: "Din første faktura er tæt på" })).toBeTruthy()
    expect(container.querySelector("[data-slot=dashboard-hero]")).toBeNull()
    expect(container.querySelector("[data-slot=amount]")).toBeNull()
    expect(screen.getAllByText("Fakturakladde oprettet")).toHaveLength(2)
    expect(screen.getByText("Fjord & Co")).toBeTruthy()
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
    // App screens draw no rule under a figure; documents do.
    expect(container.querySelectorAll("[data-slot=amount]:not([data-rule=none])")).toHaveLength(0)
  })

  it("says the overdue amount once, in the split, and leaves the age to the attention list", () => {
    const { container } = renderView(activeSummary())
    const hero = container.querySelector("[data-slot=dashboard-hero]")!
    expect(hero.textContent!.match(/8\.750,00\skr\./g)).toHaveLength(1)
    expect(hero.textContent).not.toContain("Den ældste")
  })

  it("says so when nothing is owed", () => {
    const summary = activeSummary({
      outstanding: emptyTotal(),
      overdue: { ...emptyTotal(), oldestDaysOverdue: 0 },
      incoming: [],
      attention: [],
    })
    renderView(summary)
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
    expect(screen.getByText("Beløb i andre valutaer vises ikke her.")).toBeTruthy()
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
  it("shows how late or how soon each invoice is", () => {
    const { container } = renderView(activeSummary())
    const incoming = container.querySelector("[data-slot=dashboard-incoming]") as HTMLElement
    expect(within(incoming).getByText("14 dage over tid")).toBeTruthy()
    expect(within(incoming).getByText("Forfalder om 3 dage")).toBeTruthy()
  })

  it("does not offer a second reminder for what the attention list already offers", () => {
    const { container } = renderView(activeSummary())
    const incoming = container.querySelector("[data-slot=dashboard-incoming]") as HTMLElement
    expect(within(incoming).queryByRole("button", { name: "Send påmindelse" })).toBeNull()
  })
})

describe("attention reasons and actions", () => {
  const item = (overrides: Partial<Summary["attention"][number]>): Summary["attention"][number] => ({
    documentId: "doc-1",
    number: "2026-9",
    customerName: "Kunde",
    amount: money("DKK", "100.00"),
    kind: "invoice",
    dueDate: null,
    daysOverdue: null,
    isOverdue: false,
    expiresOn: null,
    reason: "invoice_overdue",
    canRemind: false,
    ...overrides,
  })
  const reasons: Array<[string, Partial<Summary["attention"][number]>, string, string]> = [
    ["overdue by days", { reason: "invoice_overdue", isOverdue: true, daysOverdue: 5, dueDate: "2026-10-03" }, "Faktura 2026-9 er 5 dage over tid", "Åbn faktura"],
    ["due today (zero days)", { reason: "invoice_overdue", isOverdue: true, daysOverdue: 0, dueDate: "2026-10-08" }, "Faktura 2026-9 forfalder i dag", "Åbn faktura"],
    ["a draft", { reason: "draft_older_than_7_days" }, "Fakturakladde, der ikke er sendt", "Åbn kladde"],
    ["a quote with an expiry date", { reason: "quote_expiring", kind: "quote", expiresOn: "2026-10-12" }, "Tilbud 2026-9 udløber 12. okt.", "Følg op"],
    ["a quote without one", { reason: "quote_expiring", kind: "quote" }, "Tilbud 2026-9 udløber snart", "Følg op"],
    ["a failed email", { reason: "email_failed" }, "E-mailen med faktura 2026-9 blev ikke leveret", "Se levering"],
    ["an unconfirmed email", { reason: "email_unconfirmed" }, "Levering af faktura 2026-9 er ikke bekræftet", "Se levering"],
  ]

  it.each(reasons)("%s says why and offers one action that opens the document", (_name, overrides, sentence, action) => {
    renderView(emptySummary({ outstanding: total(bucket("DKK", "100.00")), attention: [item(overrides)] }))
    expect(screen.getByText(sentence)).toBeTruthy()
    const link = screen.getAllByRole("link", { name: action })[0]!
    expect(link.getAttribute("href")).toBe(overrides.kind === "quote" ? "/quotes/doc-1" : "/invoices/doc-1")
  })

  it("colours a row amber for a real arrear only, never for zero days", () => {
    const tones = (attention: Summary["attention"]) => {
      const { container } = renderView(emptySummary({ outstanding: total(bucket("DKK", "100.00")), attention }))
      const found = Array.from(container.querySelectorAll("[data-slot=dashboard-attention] [data-tone]")).map((el) => el.getAttribute("data-tone"))
      cleanup()
      return found
    }
    expect(tones([item({ isOverdue: true, daysOverdue: 3 })])).toEqual(["warning"])
    // Due today but flagged overdue by the server for now: neutral.
    expect(tones([item({ isOverdue: true, daysOverdue: 0 })])).toEqual(["muted"])
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
    const sending = await screen.findByRole("button", { name: "Sender…" })
    expect((sending as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(sending)
    expect(send).toHaveBeenCalledTimes(1)
    finish({ delivery: "sent" })
    await waitFor(() => expect(screen.getByText("Påmindelse sendt")).toBeTruthy())
  })

  const refusal = (data: { reason?: string; code?: string }) =>
    Object.assign(new Error("Server English that must never reach the screen"), { data })

  it.each([
    [{ reason: "already_reminded", code: "BAD_REQUEST" }, "Der er allerede sendt en påmindelse i dag"],
    [{ reason: "missing_recipient", code: "BAD_REQUEST" }, "Kunden har ingen e-mailadresse"],
    [{ reason: "email_unavailable", code: "BAD_REQUEST" }, "E-mail er ikke sat op endnu. Åbn indstillinger"],
    [{ reason: "not_remindable", code: "BAD_REQUEST" }, "Fakturaen er ikke åben længere"],
    [{ code: "FORBIDDEN" }, "Din rolle må ikke sende påmindelser"],
    [{ code: "NOT_FOUND" }, "Fakturaen findes ikke længere"],
  ])("words the refusal %j from the catalogue, and lets the person try again", async (data, text) => {
    const settled = vi.fn()
    renderView(activeSummary(), async () => {
      throw refusal(data)
    }, settled)
    fireEvent.click(screen.getByRole("button", { name: "Send påmindelse" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(text))
    expect(screen.queryByText(/Server English/)).toBeNull()
    expect(screen.getByRole("button", { name: "Send påmindelse" })).toBeTruthy()
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it("never shows raw server text: a refusal without a known code gets the generic line", async () => {
    renderView(activeSummary(), async () => {
      throw refusal({ code: "INTERNAL_SERVER_ERROR" })
    })
    fireEvent.click(screen.getByRole("button", { name: "Send påmindelse" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Påmindelsen blev ikke sendt"))
    expect(screen.queryByText(/Server English/)).toBeNull()
  })

  it("falls back to the generic line when the failure has no shape at all", async () => {
    renderView(activeSummary(), async () => {
      throw "boom"
    })
    fireEvent.click(screen.getByRole("button", { name: "Send påmindelse" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Påmindelsen blev ikke sendt"))
  })

  it("keeps the refusal on screen when the reload takes the reminder away", async () => {
    const send = vi.fn(async () => {
      throw refusal({ reason: "already_reminded" })
    })
    const view = renderView(activeSummary(), send)
    fireEvent.click(screen.getByRole("button", { name: "Send påmindelse" }))
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    const reloaded = activeSummary()
    reloaded.attention[0] = { ...reloaded.attention[0]!, canRemind: false }
    view.rerender(
      <I18nProvider locale="da-DK">
        <DashboardView summary={reloaded} sendReminder={send} />
      </I18nProvider>
    )
    expect(screen.queryByRole("button", { name: "Send påmindelse" })).toBeNull()
    expect(screen.getByRole("alert").textContent).toBe("Der er allerede sendt en påmindelse i dag")
    expect(screen.getAllByRole("link", { name: "Åbn faktura" }).length).toBeGreaterThan(0)
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

describe("page subtitle", () => {
  const subtitle = (container: HTMLElement) => container.querySelector("[data-slot=page-header] p")!.textContent

  it("is the date in the organization's time zone, not a count", () => {
    const { container } = renderView(activeSummary())
    expect(subtitle(container)).toBe("Torsdag 8. okt. 2026")
    // The hero counts the invoices; the subtitle must not count them again, in another number.
    expect(subtitle(container)).not.toMatch(/faktura/)
  })

  it("reads the day in the summary's zone, so it can differ from UTC", () => {
    const summary = activeSummary({ asOf: "2026-10-08T23:30:00.000Z" })
    expect(subtitle(renderView(summary).container)).toBe("Fredag 9. okt. 2026")
    cleanup()
    expect(subtitle(renderView({ ...summary, timezone: "UTC" }).container)).toBe("Torsdag 8. okt. 2026")
  })

  it("is the same line when everything is paid", () => {
    const summary = activeSummary({ outstanding: emptyTotal(), overdue: { ...emptyTotal(), oldestDaysOverdue: 0 }, incoming: [], attention: [] })
    expect(subtitle(renderView(summary).container)).toBe("Torsdag 8. okt. 2026")
  })

  it("keeps the first-run and drafts lines", () => {
    expect(subtitle(renderView(emptySummary()).container)).toBe("Her samles dine penge, så snart du har sendt en faktura.")
  })

  it("is written out in English as well", () => {
    const { container } = render(
      <I18nProvider locale="en-US">
        <DashboardView summary={activeSummary()} sendReminder={async () => ({ delivery: "sent" })} />
      </I18nProvider>
    )
    expect(subtitle(container)).toBe("Thursday 8 Oct 2026")
  })
})

describe("getting started actions", () => {
  const drafted = (count: number, newestId: string | null, newestKind: "invoice" | "quote" | null) =>
    emptySummary({ drafts: { count, newestId, newestKind } })

  it("continues the one draft, with the invoice list second and no second 'new'", () => {
    renderView(drafted(1, "d1", "invoice"))
    expect(screen.getByRole("link", { name: "Fortsæt kladden" }).getAttribute("href")).toBe("/invoices/d1")
    expect(screen.getByRole("link", { name: "Se fakturaer" }).getAttribute("href")).toBe("/invoices")
    expect(screen.queryByRole("link", { name: "Ny faktura" })).toBeNull()
  })

  it("opens a quote draft as a quote, and the quote list second", () => {
    renderView(drafted(1, "q1", "quote"))
    expect(screen.getByRole("link", { name: "Fortsæt kladden" }).getAttribute("href")).toBe("/quotes/q1")
    expect(screen.getByRole("link", { name: "Se tilbud" }).getAttribute("href")).toBe("/quotes")
  })

  it("with several drafts continues the newest and links to the list of its kind, so every action lands on a draft", () => {
    renderView(drafted(2, "q2", "quote"))
    expect(screen.getByRole("link", { name: "Fortsæt nyeste kladde" }).getAttribute("href")).toBe("/quotes/q2")
    expect(screen.getByRole("link", { name: "Se tilbud" }).getAttribute("href")).toBe("/quotes")
    // The old "Se kladder (2)" led to /invoices, where quote drafts do not appear.
    expect(screen.queryByRole("link", { name: /Se kladder/ })).toBeNull()
    expect(screen.queryByRole("link", { name: "Se fakturaer" })).toBeNull()
  })

  it("claims only the total for mixed drafts, never a count per list", () => {
    const { container } = renderView(drafted(3, "d9", "invoice"))
    expect(container.textContent).toContain("Du har 3 kladder")
    expect(screen.getByRole("link", { name: "Fortsæt nyeste kladde" }).getAttribute("href")).toBe("/invoices/d9")
    expect(screen.getByRole("link", { name: "Se fakturaer" }).getAttribute("href")).toBe("/invoices")
    expect(container.textContent).not.toMatch(/Fakturakladder \(|Tilbudskladder \(/)
  })

  it("points at the invoices when there is no draft but something else has happened", () => {
    renderView(emptySummary({ activity: [activityEvent({ id: "e1", type: "quote.sent", aggregateId: "q" })] }))
    expect(screen.getByRole("link", { name: "Se fakturaer" }).getAttribute("href")).toBe("/invoices")
    expect(screen.queryByRole("link", { name: "Fortsæt kladden" })).toBeNull()
  })
})

describe("incoming days", () => {
  it("says due today, neutral, and never zero days overdue, for a zero-day arrear", () => {
    const summary = activeSummary()
    summary.incoming[0] = { ...summary.incoming[0]!, daysOverdue: 0, isOverdue: true }
    const { container } = renderView(summary)
    const incoming = container.querySelector("[data-slot=dashboard-incoming]") as HTMLElement
    const label = within(incoming).getByText("Forfalder i dag")
    expect(label.className).not.toContain("text-tone-danger")
    expect(container.textContent).not.toMatch(/\b0 dage?/)
  })
})

describe("reminder refusals from the email provider", () => {
  const refusal = (reason: string) => Object.assign(new Error("Provider English"), { data: { reason, code: "PRECONDITION_FAILED" } })

  it.each([
    ["email_provider_refused", "Din e-mailudbyder afviste påmindelsen. Tjek e-mailindstillingerne."],
    ["email_provider_unreachable", "Vi kunne ikke nå din e-mailudbyder. Prøv igen om lidt, eller tjek e-mailindstillingerne."],
  ])("%s is worded in the catalogue, with a way to the settings", async (reason, text) => {
    renderView(activeSummary(), async () => {
      throw refusal(reason)
    })
    fireEvent.click(screen.getByRole("button", { name: "Send påmindelse" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(text))
    expect(screen.queryByText(/Provider English/)).toBeNull()
    expect(within(screen.getByRole("alert")).getByRole("link", { name: "Åbn indstillinger" }).getAttribute("href")).toBe("/settings/email")
  })

  it("offers no settings link for a refusal settings cannot fix", async () => {
    renderView(activeSummary(), async () => {
      throw refusal("already_reminded")
    })
    fireEvent.click(screen.getByRole("button", { name: "Send påmindelse" }))
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(within(screen.getByRole("alert")).queryByRole("link")).toBeNull()
  })
})

describe("activity lines", () => {
  it("names the document and the customer", () => {
    renderView(activeSummary())
    expect(screen.getByText("Faktura 2026-148 betalt").getAttribute("href")).toBe("/invoices/inv-paid")
    expect(screen.getByText("Nordlys Studio")).toBeTruthy()
  })
})

describe("a refusal after the reminder is no longer allowed", () => {
  const refuse = (reason: string) =>
    Object.assign(new Error("English"), { data: { reason, code: "BAD_REQUEST" } })

  it("shows the incoming list's refusal without a retry once canRemind turns false", async () => {
    const send = vi.fn(async () => {
      throw refuse("already_reminded")
    })
    // A summary where only the incoming row can be reminded (it is not in the attention list).
    const first = activeSummary()
    first.attention = []
    first.incoming[0] = { ...first.incoming[0]!, canRemind: true }
    const view = renderView(first, send)
    fireEvent.click(screen.getAllByRole("button", { name: "Send påmindelse" })[0]!)
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Der er allerede sendt en påmindelse i dag"))
    expect(screen.getAllByRole("button", { name: "Send påmindelse" }).length).toBe(1)

    const reloaded = activeSummary()
    reloaded.attention = []
    reloaded.incoming[0] = { ...reloaded.incoming[0]!, canRemind: false }
    view.rerender(
      <I18nProvider locale="da-DK">
        <DashboardView summary={reloaded} sendReminder={send} />
      </I18nProvider>
    )
    expect(screen.getByRole("alert").textContent).toBe("Der er allerede sendt en påmindelse i dag")
    expect(screen.queryByRole("button", { name: "Send påmindelse" })).toBeNull()
    // Nothing can send a second mutation.
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("keeps the retry while the server still allows the reminder", async () => {
    const send = vi.fn(async () => {
      throw refuse("email_provider_unreachable")
    })
    const summary = activeSummary()
    summary.attention = []
    summary.incoming[0] = { ...summary.incoming[0]!, canRemind: true }
    renderView(summary, send)
    fireEvent.click(screen.getByRole("button", { name: "Send påmindelse" }))
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(screen.getByRole("button", { name: "Send påmindelse" })).toBeTruthy()
  })
})

describe("the figure", () => {
  it("is there at once, with no count-up", () => {
    const { container } = renderView(activeSummary())
    expect(container.querySelector("[data-slot=dashboard-hero] [data-slot=amount]")!.textContent).toBe("20.000,00\u00a0kr.")
  })
})

describe("unvalued-only and three-decimal currencies", () => {
  it("shows an unvalued-only currency once, quietly, with its own decimals, and not in the hero figure", () => {
    const summary = activeSummary()
    summary.outstanding = {
      count: 6,
      buckets: summary.outstanding.buckets,
      unvalued: [bucket("DKK", "20000.00", 3), bucket("BHD", "12345.678"), storageBucket("ZZZ", "75.50")],
    }
    const { container } = renderView(summary)
    const hero = container.querySelector("[data-slot=dashboard-hero]")!
    expect(hero.querySelector("[data-slot=amount]")!.textContent).toBe("20.000,00\u00a0kr.")
    const lines = Array.from(hero.querySelectorAll("ul")).pop()!.textContent!
    expect(lines.match(/12\.345,678\sBHD udestående/g)).toHaveLength(1)
    // An unknown currency: two decimals and the ISO code.
    expect(lines.match(/75,50\sZZZ udestående/g)).toHaveLength(1)
    expect(lines).toContain("1.800,00\u00a0€ udestående")
    expect(container.textContent).not.toContain("20.075")
  })

  it("keeps the base currency as the figure when a three-decimal currency is all that is owed", () => {
    const summary = activeSummary({
      outstanding: unvaluedOnly(bucket("BHD", "12345.678")),
      overdue: { ...unvaluedOnly(bucket("BHD", "100.000", 1, 4)), oldestDaysOverdue: 4 },
      paidThisMonth: emptyTotal(),
      attention: [],
      incoming: [],
    })
    const { container } = renderView(summary)
    const hero = container.querySelector("[data-slot=dashboard-hero]")!
    const figure = hero.querySelector("[data-slot=amount]")!
    expect(figure.textContent).toBe("0,00\u00a0kr.")
    expect(hero.querySelector("[role=img]")).toBeNull()
    const lines = Array.from(hero.querySelectorAll("ul")).pop()!.textContent!
    expect(lines).toContain("12.345,678\u00a0BHD udestående")
    expect(lines).toContain("heraf 100,000\u00a0BHD forfaldent")
    // Something is overdue (in BHD), so "nothing is overdue" must not be said.
    expect(hero.textContent).not.toContain("Intet er forfaldent")
  })

  it("says nothing is overdue only when no invoice at all is", () => {
    const summary = activeSummary({
      outstanding: unvaluedOnly(bucket("BHD", "12345.678")),
      overdue: { ...emptyTotal(), oldestDaysOverdue: 0 },
      paidThisMonth: emptyTotal(),
      attention: [],
      incoming: [],
    })
    const { container } = renderView(summary)
    expect(container.querySelector("[data-slot=dashboard-hero]")!.textContent).toContain("Intet er forfaldent")
  })

  it("writes a storage-precision amount with two decimals and the code in the hero lines", () => {
    const summary = activeSummary()
    summary.outstanding = { count: 4, buckets: summary.outstanding.buckets, unvalued: [storageBucket("CLP", "75.50")] }
    const { container } = renderView(summary)
    const lines = Array.from(container.querySelectorAll("[data-slot=dashboard-hero] ul")).pop()!.textContent!
    expect(lines).toContain("75,50\u00a0CLP udestående")
    expect(lines).not.toContain("76")
  })

  it("keeps a row's stated precision in the incoming and attention lists and their labels", () => {
    const summary = activeSummary()
    summary.incoming[1] = { ...summary.incoming[1]!, amount: { ...storageBucket("CLP", "75.50") }, total: { ...storageBucket("CLP", "75.50") } }
    summary.attention[0] = { ...summary.attention[0]!, amount: { ...storageBucket("JPY", "1500.25") } }
    summary.incoming[2] = { ...summary.incoming[0]!, documentId: "inv-bhd", amount: bucket("BHD", "1250.500"), total: bucket("BHD", "1250.500"), isOverdue: false, daysOverdue: 0 }
    const { container } = renderView(summary)
    const incoming = container.querySelector("[data-slot=dashboard-incoming]") as HTMLElement
    const texts = Array.from(incoming.querySelectorAll("[data-slot=amount]")).map((el) => el.textContent)
    expect(texts).toContain("75,50\u00a0CLP")
    expect(texts).toContain("1.250,500\u00a0BHD")
    const attention = container.querySelector("[data-slot=dashboard-attention]") as HTMLElement
    expect(Array.from(attention.querySelectorAll("[data-slot=amount]")).map((el) => el.textContent)).toContain("1.500,25\u00a0JPY")
  })
})

describe("received, not paid", () => {
  it("calls the hero segment Modtaget, never Betalt", () => {
    const { container } = renderView(activeSummary())
    const hero = container.querySelector("[data-slot=dashboard-hero]")!
    expect(hero.textContent).toContain("Modtaget i oktober")
    expect(hero.textContent).not.toMatch(/Betalt/)
    expect(hero.querySelector("[role=img]")!.getAttribute("aria-label")).toBe(
      "Fordeling af oktober: modtaget 10.000,00\u00a0kr., på vej 11.250,00\u00a0kr., forfaldent 8.750,00\u00a0kr."
    )
  })

  it("says Received in English", () => {
    const { container } = render(
      <I18nProvider locale="en-US">
        <DashboardView summary={activeSummary()} sendReminder={async () => ({ delivery: "sent" })} />
      </I18nProvider>
    )
    const hero = container.querySelector("[data-slot=dashboard-hero]")!
    expect(hero.textContent).toContain("Received in October")
    expect(hero.textContent).not.toMatch(/Paid/)
    expect(screen.getByText("Received")).toBeTruthy()
  })
})

describe("calendar dates in the view", () => {
  const original = process.env.TZ
  afterEach(() => {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })

  it("prints a quote's expiry day as stored, in a western time zone", () => {
    process.env.TZ = "America/New_York"
    renderView(emptySummary({ outstanding: total(bucket("DKK", "100.00")), attention: [quoteAttention()] }))
    expect(screen.getByText("Tilbud T-2026-014 udløber 12. okt.")).toBeTruthy()
  })

  it("counts days to a stored due date from the organization's today, in a western time zone", () => {
    process.env.TZ = "America/New_York"
    const { container } = renderView(activeSummary())
    expect(within(container.querySelector("[data-slot=dashboard-incoming]") as HTMLElement).getByText("Forfalder om 3 dage")).toBeTruthy()
  })
})
