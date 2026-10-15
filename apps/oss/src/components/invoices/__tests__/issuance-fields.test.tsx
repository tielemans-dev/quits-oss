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
    const field = screen.getByLabelText("Leveringsdato")
    expect(field.id).toBe("supplyDate")
    expect(field.textContent).toBe("05.10.2026")

    fireEvent.click(field)
    const day = (await screen.findAllByRole("gridcell")).find(cell => cell.textContent === "12")
    fireEvent.click(day!.querySelector("button")!)
    expect(seen).toHaveBeenLastCalledWith("2026-10-12")
    expect(screen.getByLabelText("Leveringsdato").textContent).toBe("12.10.2026")
  })
})
