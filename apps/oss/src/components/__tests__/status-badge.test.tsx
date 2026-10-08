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

import { StatusBadge, ToneBadge } from "../status-badge"

afterEach(() => {
  cleanup()
  state.locale = "en-US"
})

describe("StatusBadge", () => {
  it("shows the label and carries the tone of the status", () => {
    render(<StatusBadge domain="invoice" status="overdue" />)

    const badge = screen.getByText("Overdue")
    expect(badge.dataset.tone).toBe("danger")
    expect(badge.className).toContain("text-tone-danger")
    // A soft pill: the same 14% tint in light and dark, the label at full strength.
    expect(badge.className).toContain("bg-tone-danger/14")
    expect(badge.className).not.toContain("dark:")
    expect(badge.className).toContain("rounded-full")
  })

  it("draws a dot in the tone colour that assistive technology skips", () => {
    render(<StatusBadge domain="quote" status="accepted" />)

    const dot = screen.getByText("Accepted").querySelector("[aria-hidden]")
    expect(dot).not.toBeNull()
    expect(dot?.className).toContain("bg-current")
  })

  it("draws muted as a ring and every other tone as a solid dot", () => {
    render(
      <>
        <StatusBadge domain="invoice" status="credited" />
        <StatusBadge domain="invoice" status="draft" />
      </>
    )

    const ring = screen.getByText("Credited").querySelector("[aria-hidden]")
    expect(ring?.className).toContain("border-current")
    expect(ring?.className).not.toContain("bg-current")
    const solid = screen.getByText("Draft").querySelector("[aria-hidden]")
    expect(solid?.className).toContain("bg-current")
    expect(solid?.className).not.toContain("border-current")
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
