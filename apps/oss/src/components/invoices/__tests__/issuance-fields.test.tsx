// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../../lib/i18n/react"
import { IssuanceFields, type IssuanceValues } from "../issuance-fields"

const seen = vi.fn()

function Harness() {
  const [value, setValue] = useState<IssuanceValues>({ supplyDate: "2026-10-05", exchangeRate: "", rateDate: "2026-10-05" })
  return <I18nProvider locale="da-DK">
    <IssuanceFields value={value} onChange={next => { seen(next.supplyDate); setValue(next) }} currency="DKK" />
  </I18nProvider>
}

beforeEach(() => {
  vi.spyOn(window.navigator, "language", "get").mockReturnValue("en-US")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  seen.mockReset()
})

describe("IssuanceFields supply date", () => {
  it("shows the wizard locale format under an en-US browser and keeps the stored value ISO", async () => {
    render(<Harness />)
    const field = screen.getByLabelText("Leveringsdato") as HTMLInputElement
    expect(field.id).toBe("supplyDate")
    expect(field.value).toBe("05.10.2026")

    fireEvent.click(screen.getAllByRole("button", { name: "Åbn kalender" })[0]!)
    const day = (await screen.findAllByRole("gridcell")).find(cell => cell.textContent === "12")
    fireEvent.click(day!.querySelector("button")!)
    expect(seen).toHaveBeenLastCalledWith("2026-10-12")
    expect((screen.getByLabelText("Leveringsdato") as HTMLInputElement).value).toBe("12.10.2026")
  })

  it("takes a date typed in Danish order and reads it when the field is left", () => {
    render(<Harness />)
    const field = screen.getByLabelText("Leveringsdato") as HTMLInputElement
    fireEvent.change(field, { target: { value: "20/10/26" } })
    expect(seen).not.toHaveBeenCalled()
    fireEvent.blur(field)
    expect(seen).toHaveBeenLastCalledWith("2026-10-20")
    expect(field.value).toBe("20.10.2026")
    expect(field.getAttribute("aria-invalid")).toBeNull()
  })

  it("marks a typed text that is not a date and does not keep the earlier date", () => {
    render(<Harness />)
    const field = screen.getByLabelText("Leveringsdato") as HTMLInputElement
    fireEvent.change(field, { target: { value: "31.02.2026" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(seen).toHaveBeenLastCalledWith("")
    expect(field.value).toBe("31.02.2026")
    expect(field.getAttribute("aria-invalid")).toBe("true")
  })

  it("opens the calendar from the text and leaves the focus there for typing", async () => {
    render(<Harness />)
    const field = screen.getByLabelText("Leveringsdato") as HTMLInputElement
    field.focus()
    fireEvent.click(field)
    expect(await screen.findAllByRole("gridcell")).not.toHaveLength(0)
    expect(document.activeElement).toBe(field)
  })
})
