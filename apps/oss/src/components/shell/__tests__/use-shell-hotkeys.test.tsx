// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select"

import { useShellHotkeys } from "../use-shell-hotkeys"

const handlers = { togglePalette: vi.fn(), openPalette: vi.fn(), openNewMenu: vi.fn() }

function Host({ children }: { children?: React.ReactNode }) {
  useShellHotkeys(handlers)
  return <div>{children}</div>
}

afterEach(() => {
  cleanup()
  Object.values(handlers).forEach((handler) => handler.mockReset())
  document.body.innerHTML = ""
})

describe("shell hotkeys", () => {
  it("toggles the palette with Ctrl+K and ⌘K, even while typing", () => {
    render(
      <Host>
        <input aria-label="field" />
      </Host>
    )
    const field = document.querySelector("input") as HTMLInputElement

    fireEvent.keyDown(field, { key: "k", ctrlKey: true })
    fireEvent.keyDown(document.body, { key: "k", metaKey: true })
    expect(handlers.togglePalette).toHaveBeenCalledTimes(2)
  })

  it("opens the palette with / and the new menu with N", () => {
    render(<Host />)
    fireEvent.keyDown(document.body, { key: "/" })
    fireEvent.keyDown(document.body, { key: "n" })
    expect(handlers.openPalette).toHaveBeenCalledTimes(1)
    expect(handlers.openNewMenu).toHaveBeenCalledTimes(1)
  })

  it("does not treat Shift+N as N, but still opens the palette with / where it needs Shift", () => {
    render(<Host />)
    fireEvent.keyDown(document.body, { key: "N", shiftKey: true })
    expect(handlers.openNewMenu).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: "/", shiftKey: true })
    expect(handlers.openPalette).toHaveBeenCalledTimes(1)
  })

  it("leaves single keys alone while a field has the keyboard", () => {
    render(
      <Host>
        <input />
        <textarea />
      </Host>
    )
    fireEvent.keyDown(document.querySelector("input") as HTMLElement, { key: "n" })
    fireEvent.keyDown(document.querySelector("textarea") as HTMLElement, { key: "/" })
    expect(handlers.openNewMenu).not.toHaveBeenCalled()
    expect(handlers.openPalette).not.toHaveBeenCalled()
  })

  it("leaves single keys alone while a dialog or menu is open, and with other modifiers held", () => {
    render(<Host />)
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    dialog.setAttribute("data-state", "open")
    document.body.appendChild(dialog)
    fireEvent.keyDown(document.body, { key: "n" })
    expect(handlers.openNewMenu).not.toHaveBeenCalled()

    dialog.setAttribute("data-state", "closed")
    fireEvent.keyDown(document.body, { key: "n", altKey: true })
    expect(handlers.openNewMenu).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: "n" })
    expect(handlers.openNewMenu).toHaveBeenCalledTimes(1)
  })

  it("leaves typeahead to an open Select: N on an option does not open the menu", async () => {
    // Radix Select measures and scrolls in ways jsdom lacks.
    window.HTMLElement.prototype.scrollIntoView = () => undefined
    window.HTMLElement.prototype.hasPointerCapture = () => false
    window.HTMLElement.prototype.releasePointerCapture = () => undefined
    render(
      <Host>
        <Select defaultOpen>
          <SelectTrigger>
            <SelectValue placeholder="Vælg" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="nordlys">Nordlys</SelectItem>
            <SelectItem value="norden">Norden</SelectItem>
          </SelectContent>
        </Select>
      </Host>
    )

    const option = screen.getByRole("option", { name: "Nordlys" })
    fireEvent.keyDown(option, { key: "n" })
    fireEvent.keyDown(option, { key: "/" })
    expect(handlers.openNewMenu).not.toHaveBeenCalled()
    expect(handlers.openPalette).not.toHaveBeenCalled()
    // Radix focuses the chosen item on a timer; let it fire before the test unmounts the Select.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
  })

  it("treats an open popup list as owning the keyboard, and a closed one as not", () => {
    render(<Host />)
    const list = document.createElement("div")
    list.setAttribute("role", "listbox")
    list.setAttribute("data-state", "open")
    document.body.appendChild(list)
    fireEvent.keyDown(document.body, { key: "n" })
    expect(handlers.openNewMenu).not.toHaveBeenCalled()

    list.setAttribute("data-state", "closed")
    fireEvent.keyDown(document.body, { key: "n" })
    expect(handlers.openNewMenu).toHaveBeenCalledTimes(1)
  })
})
