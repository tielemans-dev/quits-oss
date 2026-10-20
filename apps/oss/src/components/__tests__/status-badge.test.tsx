// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ locale: "en-US" }))

vi.mock("../../lib/i18n/react", async () => {
  const { translate } = await import("../../lib/i18n/translate")
  return {
    useI18n: () => ({
      locale: state.locale,
      t: (key: Parameters<typeof translate>[0]) => translate(key, state.locale),
    }),
  }
})

import { invoiceDisplayStatus } from "../../lib/payments/invoice-display-status"

import { StatusBadge, ToneBadge } from "../status-badge"

afterEach(() => {
  cleanup()
  state.locale = "en-US"
})

describe("StatusBadge", () => {
  it.each([["en-US", "Overdue"], ["da-DK", "Forfalden"]])(
    "shows a past-due sent invoice in %s",
    (locale, label) => {
      state.locale = locale
      const status = invoiceDisplayStatus(
        { status: "sent", paymentStatus: "unpaid", balanceDue: 100, dueDate: "2026-10-11" },
        "Europe/Copenhagen",
        new Date("2026-10-12T10:00:00Z")
      )
      render(<StatusBadge domain="invoice" status={status} />)
      expect(screen.getByText(label).dataset.tone).toBe("warning")
    }
  )

  it.each([["en-US", "Sent"], ["da-DK", "Sendt"]])(
    "keeps a zero-balance past-due invoice sent in %s",
    (locale, label) => {
      state.locale = locale
      const status = invoiceDisplayStatus(
        { status: "sent", paymentStatus: "unpaid", balanceDue: 0, dueDate: "2026-10-11" },
        "Europe/Copenhagen",
        new Date("2026-10-12T10:00:00Z")
      )
      render(<StatusBadge domain="invoice" status={status} />)
      expect(screen.getByText(label).dataset.tone).toBe("info")
    }
  )

  it("shows the label and carries the tone of the status", () => {
    render(<StatusBadge domain="invoice" status="overdue" />)

    const badge = screen.getByText("Overdue")
    expect(badge.dataset.tone).toBe("warning")
    // The label in the tone on the tone at 10%, the same in light and dark, on a 4px badge.
    expect(badge.className).toContain("text-tone-warning")
    expect(badge.className).toContain("bg-tone-warning-soft")
    expect(badge.className).not.toContain("dark:")
    expect(badge.className).toContain("rounded-sm")
  })

  it("draws no dot: the label alone says the status", () => {
    render(<StatusBadge domain="invoice" status="sent" />)

    expect(screen.getByText("Sent").querySelector("[aria-hidden]")).toBeNull()
  })

  it("keeps a screen to green, amber and red: every other tone is one quiet neutral", () => {
    render(
      <>
        <StatusBadge domain="invoice" status="draft" />
        <StatusBadge domain="invoice" status="sent" />
        <StatusBadge domain="invoice" status="viewed" />
        <StatusBadge domain="invoice" status="credited" />
        <StatusBadge domain="quote" status="accepted" />
      </>
    )

    const neutral = ["Draft", "Sent", "Viewed", "Credited"].map((label) => screen.getByText(label).className)
    expect(new Set(neutral).size).toBe(1)
    expect(neutral[0]).toContain("text-muted-foreground")
    expect(screen.getByText("Accepted").className).toContain("text-tone-success")
  })

  it.each([["en-US", "Sending"], ["da-DK", "Sender"]])(
    "shows an invoice whose email is still being delivered as %s, not as a draft",
    (locale, label) => {
      state.locale = locale
      const status = invoiceDisplayStatus(
        { status: "draft", paymentStatus: "unpaid", balanceDue: 100, lastEmailAttemptOutcome: "sending" },
        "Europe/Copenhagen"
      )
      render(<StatusBadge domain="invoice" status={status} />)
      expect(screen.getByText(label).dataset.tone).toBe("info")
      expect(screen.queryByText("Draft")).toBeNull()
      expect(screen.queryByText("Kladde")).toBeNull()
    }
  )

  it.each([["en-US", "Sent"], ["da-DK", "Sendt"]])("shows an issued invoice as %s after a failed resend", (locale, label) => {
    state.locale = locale
    const status = invoiceDisplayStatus(
      { status: "sent", paymentStatus: "unpaid", balanceDue: 100, lastEmailAttemptOutcome: "failed" },
      "Europe/Copenhagen"
    )
    render(<StatusBadge domain="invoice" status={status} />)
    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.queryByText("Draft")).toBeNull()
    expect(screen.queryByText("Kladde")).toBeNull()
  })

  it("translates the label", () => {
    state.locale = "da-DK"
    render(<StatusBadge domain="invoice" status="partially_paid" />)
    expect(screen.getByText("Delvist betalt").dataset.tone).toBe("warning")
  })

  it("shows an unknown status as it is, in the neutral tone", () => {
    render(<StatusBadge domain="invoice" status="mystery" />)
    expect(screen.getByText("mystery").dataset.tone).toBe("neutral")
  })
})

describe("ToneBadge", () => {
  it("renders a caller-translated label in a tone", () => {
    render(<ToneBadge tone="warning">Delivery unconfirmed</ToneBadge>)
    expect(screen.getByText("Delivery unconfirmed").dataset.tone).toBe("warning")
  })
})
