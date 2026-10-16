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

const sheet = () => render(<CommandPalette inline open onOpenChange={() => {}} can={() => true} billingEnabled={false} />)

describe("inline command palette", () => {
  it("is a field in the page that becomes the card for what is typed, without waiting for a pause", async () => {
    readings(() => {})
    sheet()
    expect(screen.queryByRole("dialog")).toBeNull()
    const input = screen.getByRole("combobox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "betal" } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(screen.getByText("Kort for Birk")).toBeTruthy()
  })

  it("offers the other readings beside the card, switched with the arrows, and ⌘↵ presses the card's own button", async () => {
    const confirm = vi.fn()
    readings(confirm)
    sheet()
    const input = screen.getByRole("combobox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "betal" } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(screen.getAllByRole("radio").map((chip) => chip.getAttribute("aria-checked"))).toEqual(["true", "false"])
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(screen.getByText("Kort for Studio")).toBeTruthy()
    fireEvent.keyDown(input, { key: "Enter", metaKey: true })
    expect(confirm).toHaveBeenCalledWith("Studio")
  })

  it("empties on Esc, then folds back into a field", async () => {
    readings(() => {})
    sheet()
    const input = screen.getByRole("combobox") as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "betal" } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    fireEvent.keyDown(input, { key: "Escape" })
    expect(input.value).toBe("")
    expect(screen.queryByText("Kort for Birk")).toBeNull()
    fireEvent.keyDown(input, { key: "Escape" })
    expect(document.querySelector("[data-unfolded]")?.getAttribute("data-unfolded")).toBe("false")
  })
})
