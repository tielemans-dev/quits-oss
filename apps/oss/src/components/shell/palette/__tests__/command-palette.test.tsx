// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => router.navigate }))
vi.mock("../../../../lib/i18n/react", async () => {
  const { translate } = await import("../../../../lib/i18n/translate")
  // One function for every render, as the real provider's is for a given language.
  const value = { t: (key: never, vars?: Record<string, string | number>) => translate(key, "da-DK", vars) }
  return { useI18n: () => value }
})

import { CommandPalette } from "../command-palette"
import { registerPaletteProvider, resetPaletteProvidersForTesting } from "../registry"
import type { PaletteCapability } from "../types"

function Harness({ can }: { can: (action: PaletteCapability) => boolean }) {
  const [open, setOpen] = useState(true)
  return <CommandPalette open={open} onOpenChange={setOpen} can={can} billingEnabled={false} />
}

afterEach(() => {
  cleanup()
  resetPaletteProvidersForTesting()
  router.navigate.mockReset()
})

const everything = () => true

describe("command palette", () => {
  it("is a labelled combobox over a listbox, with the first option active", () => {
    render(<Harness can={everything} />)

    const input = screen.getByRole("combobox")
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id)
    const options = screen.getAllByRole("option")
    expect(options[0].getAttribute("aria-selected")).toBe("true")
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id)
  })

  it("offers create actions only for what the member may create", () => {
    render(<Harness can={(action) => action === "contact:create"} />)

    expect(screen.queryByRole("option", { name: "Ny faktura" })).toBeNull()
    expect(screen.getByRole("option", { name: "Ny kunde" })).toBeTruthy()
  })

  it("does not offer Billing where billing is off", () => {
    render(<Harness can={everything} />)
    expect(screen.queryByRole("option", { name: "Abonnement" })).toBeNull()
    expect(screen.getByRole("option", { name: /Indstillinger/ })).toBeTruthy()
  })

  it("filters as you type and opens the active item with Enter", () => {
    render(<Harness can={everything} />)

    const input = screen.getByRole("combobox")
    fireEvent.change(input, { target: { value: "kredit" } })
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("Kreditnotaer"),
    ])

    fireEvent.keyDown(input, { key: "Enter" })
    expect(router.navigate).toHaveBeenCalledWith({ to: "/credit-notes" })
    expect(screen.queryByRole("combobox")).toBeNull()
  })

  it("moves with the arrow keys and wraps around", () => {
    render(<Harness can={everything} />)

    const input = screen.getByRole("combobox")
    const options = () => screen.getAllByRole("option")
    fireEvent.keyDown(input, { key: "ArrowUp" })
    expect(options().at(-1)?.getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(options()[0].getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(options()[1].getAttribute("aria-selected")).toBe("true")
  })

  it("says so when nothing matches", () => {
    render(<Harness can={everything} />)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzzz" } })
    expect(screen.getByText("Ingen resultater for “zzzz”")).toBeTruthy()
  })

  it("closes on Escape", () => {
    render(<Harness can={everything} />)
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" })
    expect(screen.queryByRole("combobox")).toBeNull()
  })

  it("shows what a registered provider offers, ahead of the built-ins, and runs its item", async () => {
    const perform = vi.fn()
    const unregister = registerPaletteProvider({
      id: "draft-from-text",
      order: 50,
      sections: ({ query }) =>
        query.split(" ").length >= 3
          ? [{ id: "draft", heading: "Kladde", items: [{ id: "draft:1", label: `Faktura: ${query}`, perform }] }]
          : [],
    })
    render(<Harness can={everything} />)

    const input = screen.getByRole("combobox")
    expect(screen.queryByText("Kladde")).toBeNull()
    fireEvent.change(input, { target: { value: "faktura til Nordlys" } })

    const options = screen.getAllByRole("option")
    expect(options[0].textContent).toBe("Faktura: faktura til Nordlys")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(perform).toHaveBeenCalledTimes(1)
    // An item that acts in place decides itself whether to close.
    expect(screen.queryByRole("combobox")).not.toBeNull()

    unregister()
  })

  it("waits for an async provider and drops an answer for a query that has changed", async () => {
    let resolveFirst: (value: never[]) => void = () => undefined
    registerPaletteProvider({
      id: "slow",
      order: 10,
      sections: ({ query }) =>
        query === "a"
          ? new Promise<never[]>((resolve) => {
              resolveFirst = resolve
            })
          : Promise.resolve([{ id: "slow", items: [{ id: "slow:1", label: `Svar på ${query}`, perform: () => undefined }] }]),
    })
    render(<Harness can={everything} />)

    const input = screen.getByRole("combobox")
    fireEvent.change(input, { target: { value: "a" } })
    fireEvent.change(input, { target: { value: "ab" } })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText("Svar på ab")).toBeTruthy()

    await act(async () => {
      resolveFirst([] as never[])
    })
    expect(screen.getByText("Svar på ab")).toBeTruthy()
  })
})
