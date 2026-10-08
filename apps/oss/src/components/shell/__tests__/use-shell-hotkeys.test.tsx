// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

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
})
