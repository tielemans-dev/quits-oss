// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => router.navigate }))
vi.mock("../../../../lib/i18n/react", async () => {
  const { translate } = await import("../../../../lib/i18n/translate")
  const value = { t: (key: never, vars?: Record<string, string | number>) => translate(key, "da-DK", vars) }
  return { useI18n: () => value }
})

import { CommandPalette } from "../command-palette"
import { registerPaletteProvider, resetPaletteProvidersForTesting } from "../registry"

afterEach(() => {
  cleanup()
  resetPaletteProvidersForTesting()
})

/** Two readings of "betal", each with a card whose own button says which it is. */
function readings(confirm: (name: string) => void) {
  return registerPaletteProvider({
    id: "readings",
    order: 10,
    sections: ({ query }) => query === "betal" ? [{
      id: "readings",
      items: ["Birk", "Studio"].map((name) => ({
        id: `reading:${name}`,
        label: name,
        perform: () => undefined,
        card: () => <div><p>Kort for {name}</p><button type="button" data-primary onClick={() => confirm(name)}>Bekræft {name}</button></div>,
      })),
    }] : [],
  })
}

const palette = () => render(<CommandPalette open onOpenChange={() => {}} can={() => true} billingEnabled={false} />)
// The card shows once typing pauses.
const pause = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) })

describe("command palette readings", () => {
  it("offers the other readings beside the card, switched with the arrows", async () => {
    readings(() => {})
    palette()
    const input = screen.getByRole("combobox")
    fireEvent.change(input, { target: { value: "betal" } })
    await pause()

    expect(screen.getByText("Kort for Birk")).toBeTruthy()
    expect(screen.getAllByRole("radio").map((chip) => chip.getAttribute("aria-checked"))).toEqual(["true", "false"])
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(screen.getByText("Kort for Studio")).toBeTruthy()
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(screen.getByText("Kort for Birk")).toBeTruthy()
    fireEvent.click(screen.getByRole("radio", { name: "Studio" }))
    expect(screen.getByText("Kort for Studio")).toBeTruthy()
  })

  it("presses the card's own button on ⌘↵ or Ctrl+↵, and nothing on a plain Enter", async () => {
    const confirm = vi.fn()
    readings(confirm)
    palette()
    const input = screen.getByRole("combobox")
    fireEvent.change(input, { target: { value: "betal" } })
    await pause()

    fireEvent.keyDown(input, { key: "Enter" })
    expect(confirm).not.toHaveBeenCalled()
    input.focus()
    fireEvent.keyDown(input, { key: "Enter", metaKey: true })
    expect(confirm).toHaveBeenCalledWith("Birk")
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true })
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})
