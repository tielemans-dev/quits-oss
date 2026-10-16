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
})
