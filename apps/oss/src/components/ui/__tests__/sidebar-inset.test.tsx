// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Sidebar, SidebarProvider, SidebarTrigger } from "../sidebar"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderSidebar(width: number) {
  vi.stubGlobal("innerWidth", width)
  vi.stubGlobal("matchMedia", () => ({ matches: width < 768, addEventListener() {}, removeEventListener() {} }))
  return render(
    <SidebarProvider>
      <Sidebar>nav</Sidebar>
      <SidebarTrigger />
    </SidebarProvider>
  )
}

// A host can pin a bar above the app (`--app-inset-top`); the sidebar must not slide under it.
describe("sidebar below a pinned bar", () => {
  it("starts the mobile drawer below the inset", () => {
    renderSidebar(375)
    fireEvent.click(screen.getByRole("button"))
    const drawer = document.querySelector("[data-mobile='true']")
    expect(drawer?.className).toContain("top-(--app-inset-top)")
    expect(drawer?.className).not.toContain("h-full")
  })

  it("starts the desktop sidebar below the inset", () => {
    const { container } = renderSidebar(1280)
    const panel = container.querySelector("[data-slot='sidebar-container']")
    expect(panel?.className).toContain("top-(--app-inset-top)")
    expect(panel?.className).toContain("h-[calc(100svh-var(--app-inset-top))]")
  })
})
