// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import { VatPeriodCard } from "../vat-period-card"

afterEach(() => cleanup())

describe("VatPeriodCard", () => {
  it("shows the saved period and a way back to not set", () => {
    const onChange = vi.fn()
    render(<VatPeriodCard value="quarterly" onChange={onChange} />)

    expect((screen.getByLabelText("settings.vatPeriod.option.quarterly") as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByLabelText("settings.vatPeriod.option.half_yearly"))
    expect(onChange).toHaveBeenLastCalledWith("half_yearly")
    fireEvent.click(screen.getByLabelText("settings.vatPeriod.option.none"))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it("reads as not set when no period is stored, and cannot be changed while saving", () => {
    render(<VatPeriodCard value={null} busy onChange={vi.fn()} />)

    expect((screen.getByLabelText("settings.vatPeriod.option.none") as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText("settings.vatPeriod.option.quarterly") as HTMLInputElement).disabled).toBe(true)
  })
})
