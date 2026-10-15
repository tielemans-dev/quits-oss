import { describe, expect, it } from "vitest"

import { invoiceDisplayStatus } from "../../../lib/payments/invoice-display-status"
import { VAT_NOTICE_DAYS, presentMorning, type DraftInvoice, type MorningSettings } from "../morning-model"

const row = (id: string, extra: Partial<DraftInvoice> = {}): DraftInvoice => ({
  id, number: `F-${id}`, status: "sent", paymentStatus: "unpaid", dueDate: "2020-01-10T00:00:00.000Z",
  balanceDue: 1000, total: 1000, currency: "DKK", contact: { name: `Kunde ${id}` }, contactId: `c${id}`, ...extra,
})
const settings = (extra: Partial<MorningSettings> = {}): MorningSettings => ({
  timezone: "Europe/Copenhagen", countryCode: "DK", taxRegime: "eu_vat", momsRegistered: true, vatPeriod: "quarterly", ...extra,
})
const none = new Set<string>()
const model = (invoices: DraftInvoice[], extra: Partial<Parameters<typeof presentMorning>[0]> = {}) =>
  presentMorning({ invoices, settings: settings(), reminded: none, readyKeys: none, today: "2026-10-14", ...extra })

describe("morning overview", () => {
  const invoices = [
    row("1", { balanceDue: 1250.5, dueDate: "2020-01-10T00:00:00.000Z" }),
    row("2", { balanceDue: 750, dueDate: "2020-02-10T00:00:00.000Z" }),
    row("3", { status: "paid", paymentStatus: "paid", balanceDue: 0 }),
    row("4", { dueDate: "2099-01-01T00:00:00.000Z" }),
    row("5", { status: "draft", total: 5000 }),
  ]

  it("counts as overdue exactly the rows the invoice list shows as overdue", () => {
    const shown = invoices.filter((invoice) => invoiceDisplayStatus(invoice, "Europe/Copenhagen") === "overdue")
    const { overdue } = model(invoices)

    expect(overdue.count).toBe(shown.length)
    expect(overdue.count).toBe(2)
    expect(overdue.totals).toEqual([{ currency: "DKK", amount: 2000.5 }])
    expect(overdue.batch).toBe(2)
    expect(overdue.oldestDays).toBeGreaterThan(2000)
  })

  it("leaves out an invoice whose rykker already went out, as the list does", () => {
    const { overdue } = model(invoices, { reminded: new Set(["1"]) })

    expect(overdue.count).toBe(1)
    expect(overdue.totals).toEqual([{ currency: "DKK", amount: 750 }])
  })

  it("keeps one total per currency", () => {
    const { overdue } = model([row("1"), row("2", { currency: "EUR", balanceDue: 10 })])

    expect(overdue.totals).toEqual([{ currency: "DKK", amount: 1000 }, { currency: "EUR", amount: 10 }])
  })

  it("counts only drafts the send check passed for, with a customer and an amount", () => {
    const drafts = [
      row("a", { status: "draft", total: 10750 }),
      row("b", { status: "draft", total: 500 }),
      row("c", { status: "draft", total: 0 }),
      row("d", { status: "draft", contactId: null }),
      row("e", { status: "draft", lastEmailAttemptOutcome: "sending" }),
      row("f", { status: "sent" }),
    ]
    const { drafts: ready } = model(drafts, { readyKeys: new Set(["ca|DKK"]) })

    expect(ready.count).toBe(1)
    expect(ready.totals).toEqual([{ currency: "DKK", amount: 10750 }])
    expect(ready.customers).toEqual(["Kunde a"])
  })

  it("takes the moms deadline from the organization's period, for registered Danish sellers only", () => {
    expect(model([]).vat).toMatchObject({ label: "Q3", date: "2026-12-01", daysLeft: 48 })
    expect(model([], { settings: settings({ vatPeriod: "half_yearly" }) }).vat).toMatchObject({ label: "H2", date: "2027-03-01" })
    for (const other of [{ vatPeriod: null }, { momsRegistered: false }, { momsRegistered: null }, { countryCode: "SE" }, { taxRegime: "custom" }]) {
      expect(model([], { settings: settings(other) }).vat).toBeNull()
    }
    expect(model([], { settings: null }).vat).toBeNull()
  })

  it("hides when nothing is overdue, ready or close, and shows for any one of them", () => {
    const quiet = { settings: settings({ vatPeriod: null }) }
    expect(model([], quiet).visible).toBe(false)
    expect(model([row("5", { status: "draft" })], quiet).visible).toBe(false)
    expect(model([row("1")], quiet).visible).toBe(true)
    expect(model([row("5", { status: "draft" })], { ...quiet, readyKeys: new Set(["c5|DKK"]) }).visible).toBe(true)
    expect(model([], { today: "2026-12-01" }).visible).toBe(true)
    expect(model([], { today: "2026-10-02" }).vat!.daysLeft).toBe(VAT_NOTICE_DAYS)
    expect(model([], { today: "2026-10-02" }).visible).toBe(true)
    expect(model([], { today: "2026-10-01" }).visible).toBe(false)
  })
})
