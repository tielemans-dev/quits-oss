// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import { SettingsRow } from "../settings-row"

afterEach(() => cleanup())

function Row({ savedVersion }: { savedVersion: number }) {
  return (
    <>
      <form id="shared" />
      <SettingsRow label="Name" value="Acme" formId="shared" savedVersion={savedVersion}>
        <input aria-label="Name field" name="name" form="shared" defaultValue="Acme" />
      </SettingsRow>
    </>
  )
}

describe("SettingsRow", () => {
  it("keeps the field in the shared form while it shows the saved value", () => {
    render(<Row savedVersion={0} />)

    expect(screen.getByText("Acme")).toBeTruthy()
    expect(new FormData(document.getElementById("shared") as HTMLFormElement).get("name")).toBe("Acme")
  })

  it("edits in place, cancels back to the saved value and closes after a save", () => {
    const { rerender } = render(<Row savedVersion={0} />)

    fireEvent.click(screen.getByRole("button", { name: "settings.row.edit Name" }))
    const field = screen.getByLabelText("Name field") as HTMLInputElement
    fireEvent.change(field, { target: { value: "Acme ApS" } })
    fireEvent.click(screen.getByRole("button", { name: "settings.row.cancel" }))
    expect(field.value).toBe("Acme")
    expect(screen.getByRole("button", { name: "settings.row.edit Name" })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "settings.row.edit Name" }))
    expect(screen.getByRole("button", { name: "settings.row.save" }).getAttribute("form")).toBe("shared")
    rerender(<Row savedVersion={1} />)
    expect(screen.getByRole("button", { name: "settings.row.edit Name" })).toBeTruthy()
  })

  it("marks its Save as a save's origin, shows the result and lets the page reset controlled fields", () => {
    const onCancel = vi.fn()
    render(
      <SettingsRow label="CVR" value="12345674" formId="shared" origin="cvr" result={<p role="status">Saved</p>} onCancel={onCancel}>
        <input aria-label="CVR field" />
      </SettingsRow>,
    )
    expect(screen.getByRole("status").closest("[data-save-origin]")?.getAttribute("data-save-origin")).toBe("cvr")
    fireEvent.click(screen.getByRole("button", { name: "settings.row.edit CVR" }))
    expect(screen.getByRole("button", { name: "settings.row.save" }).closest("[data-save-origin]")?.getAttribute("data-save-origin")).toBe("cvr")
    fireEvent.click(screen.getByRole("button", { name: "settings.row.cancel" }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
