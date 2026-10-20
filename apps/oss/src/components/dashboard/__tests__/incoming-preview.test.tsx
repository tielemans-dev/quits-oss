// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children?: unknown }) => <a>{children as never}</a> }))

import { I18nProvider } from "../../../lib/i18n/react"
import { previewRequest } from "../../command-bar/request-preview"
import { IncomingList } from "../incoming-list"
import { activeSummary } from "./fixtures"

afterEach(() => {
  act(() => previewRequest(null))
  cleanup()
})

const list = () => render(
  <I18nProvider locale="da-DK">
    <IncomingList items={activeSummary().incoming} today="2026-10-08" inAttention={new Set()} reminders={{}} onRemind={() => {}} />
  </I18nProvider>
)
const row = (customer: string) => screen.getByText(customer).closest("li")!

describe("IncomingList preview", () => {
  it("shows the invoice a card would add as a ghost row, and drops it when the card goes", () => {
    const { container } = list()
    act(() => previewRequest({ kind: "invoice", customer: "Havblik Design", amount: 5312.5, currency: "DKK", dueDate: "2026-10-30" }))

    const ghost = container.querySelector(".incoming-ghost")!
    expect(ghost.textContent).toContain("Havblik Design")
    expect(ghost.textContent).toContain("5.312")
    act(() => previewRequest(null))
    expect(container.querySelector(".incoming-ghost")).toBeNull()
  })

  it("marks the invoices a card would settle, and the ones it would remind", () => {
    list()
    act(() => previewRequest({ kind: "paid", invoiceIds: ["inv-overdue"] }))
    expect(row("Havn Studio").getAttribute("data-preview")).toBe("paid")
    expect(row("Nordlys ApS").getAttribute("data-preview")).toBeNull()
    expect(screen.getByText("Markeres som betalt")).toBeTruthy()

    act(() => previewRequest({ kind: "reminded", invoiceIds: ["inv-overdue", "inv-soon"] }))
    expect(row("Nordlys ApS").getAttribute("data-preview")).toBe("reminded")
    expect(screen.getAllByText("Får en påmindelse")).toHaveLength(2)
  })
})
