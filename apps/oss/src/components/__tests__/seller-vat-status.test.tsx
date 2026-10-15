// @vitest-environment jsdom
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { SellerVatStatus } from "../seller-vat-status"
import { I18nProvider } from "../../lib/i18n/react"

afterEach(cleanup)
function Choice({ locale, initial = null }: { locale: string; initial?: boolean | null }) {
  const [value, setValue] = useState(initial)
  return <I18nProvider locale={locale}><SellerVatStatus value={value} onChange={setValue} /></I18nProvider>
}
describe("seller VAT choice", () => {
  it.each([
    ["da-DK", "Er du momsregistreret?", "Jeg er momsregistreret", "Jeg er ikke momsregistreret", "Du fakturerer uden moms. Bliv momsregistreret, når du sælger for mere end 50.000 kr. på 12 måneder."],
    ["en-US", "Are you VAT-registered?", "I'm VAT-registered", "I'm not VAT-registered", "You invoice without moms. Register for VAT once you sell more than 50,000 kr. in 12 months."],
  ])("starts unselected and uses the approved %s copy", (locale, question, yes, no, hint) => {
    render(<Choice locale={locale} />)
    expect(screen.getByRole("group", { name: question })).toBeTruthy()
    const registered = screen.getByRole("radio", { name: yes }) as HTMLInputElement
    const notRegistered = screen.getByRole("radio", { name: no }) as HTMLInputElement
    expect(registered.checked).toBe(false)
    expect(notRegistered.checked).toBe(false)
    expect(screen.queryByText(hint)).toBeNull()
    expect(notRegistered.getAttribute("aria-describedby")).toBeNull()
    fireEvent.click(notRegistered)
    expect(notRegistered.checked).toBe(true)
    expect(registered.checked).toBe(false)
    expect(screen.getByText(hint).id).toBe(notRegistered.getAttribute("aria-describedby"))
    fireEvent.click(registered)
    expect(registered.checked).toBe(true)
    expect(notRegistered.checked).toBe(false)
    expect(screen.queryByText(hint)).toBeNull()
    expect(notRegistered.getAttribute("aria-describedby")).toBeNull()
    fireEvent.click(notRegistered)
    expect(notRegistered.checked).toBe(true)
    expect(registered.checked).toBe(false)
    expect(screen.getByText(hint).id).toBe(notRegistered.getAttribute("aria-describedby"))
  })
  it.each([true, false])("restores the explicit saved choice %s", initial => {
    render(<Choice locale="en-US" initial={initial} />)
    const radios = screen.getAllByRole("radio") as HTMLInputElement[]
    expect(radios[0]!.checked).toBe(initial)
    expect(radios[1]!.checked).toBe(!initial)
    expect(screen.queryByText("You invoice without moms. Register for VAT once you sell more than 50,000 kr. in 12 months.") !== null).toBe(initial === false)
  })
  it("hides the hint when an explicit nonregistered choice is withdrawn", () => {
    const onChange = () => {}
    const { rerender } = render(<I18nProvider locale="da-DK"><SellerVatStatus value={false} onChange={onChange} /></I18nProvider>)
    const hint = "Du fakturerer uden moms. Bliv momsregistreret, når du sælger for mere end 50.000 kr. på 12 måneder."
    expect(screen.getByText(hint)).toBeTruthy()
    rerender(<I18nProvider locale="da-DK"><SellerVatStatus value={null} onChange={onChange} /></I18nProvider>)
    expect(screen.queryByText(hint)).toBeNull()
    for (const radio of screen.getAllByRole("radio") as HTMLInputElement[]) {
      expect(radio.checked).toBe(false)
      expect(radio.getAttribute("aria-describedby")).toBeNull()
    }
  })
})
