// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import { AiDraftsCard } from "../ai-drafts-card"

afterEach(() => cleanup())

describe("AiDraftsCard", () => {
  it("shows one switch and no provider, model or key fields", () => {
    render(<AiDraftsCard enabled onChange={vi.fn()} />)

    expect(screen.getByRole("switch", { name: "settings.ai.drafts.label" }).getAttribute("aria-checked")).toBe("true")
    expect(screen.getByText("settings.ai.drafts.help")).toBeTruthy()
    expect(screen.queryByLabelText("settings.aiProvider.label")).toBeNull()
    expect(screen.queryByLabelText("settings.aiModel.label")).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("reports the new value when toggled and ignores clicks while saving", () => {
    const onChange = vi.fn()
    const { rerender } = render(<AiDraftsCard enabled onChange={onChange} />)
    fireEvent.click(screen.getByRole("switch"))
    expect(onChange).toHaveBeenCalledWith(false)

    rerender(<AiDraftsCard enabled={false} busy onChange={onChange} />)
    fireEvent.click(screen.getByRole("switch"))
    expect(onChange).toHaveBeenCalledOnce()
  })
})
