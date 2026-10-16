// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { I18nProvider } from "../../../lib/i18n/react"
import { CommandBar } from "../command-bar"
import { returnFromPalette } from "../../shell/palette/palette-events"
import { announceRequestOpen } from "../request-events"
import { permittedRequest, recognizeRequest } from "../request-intent"

afterEach(cleanup)

function renderBar(can: Parameters<typeof permittedRequest>[1] = () => true) {
  render(
    <I18nProvider locale="da-DK">
      <CommandBar recognize={permittedRequest(recognizeRequest, can)} />
    </I18nProvider>
  )
  return {
    input: screen.getByRole("textbox", { name: "Skriv en opgave til quits" }) as HTMLInputElement,
    submit: screen.getByRole("button", { name: "Bed quits" }) as HTMLButtonElement,
  }
}

describe("command bar", () => {
  it("hands what is typed to search when it is the page's search field", () => {
    const onSearch = vi.fn()
    render(
      <I18nProvider locale="da-DK">
        <CommandBar recognize={recognizeRequest} onSearch={onSearch} />
      </I18nProvider>
    )
    const input = screen.getByRole("textbox", { name: "Skriv en opgave til quits" }) as HTMLInputElement
    fireEvent.change(input, { target: { value: "k" } })

    expect(onSearch).toHaveBeenCalledWith(input.form, "k")
    expect(input.value).toBe("")

    // The palette put away with Esc hands the text back, so the pill is what it grew out of.
    act(() => returnFromPalette("kredit"))
    expect(input.value).toBe("kredit")
  })

  it("does nothing for text that is not a request", () => {
    const { input, submit } = renderBar()
    fireEvent.change(input, { target: { value: "nordlys" } })

    expect(submit.disabled).toBe(true)
    fireEvent.submit(input.closest("form")!)
    expect(screen.queryByRole("region")).toBeNull()
  })

  it("drops stale suggestions and opens a suggested card only after a click", async () => {
    const suggest = vi.fn(async (input: string) => ({ kind: "invoice" as const, input, suggested: { intent: "invoice" as const, items: [], confidence: 0.5, remainder: "" } }))
    render(<I18nProvider locale="da-DK"><CommandBar recognize={recognizeRequest} suggest={suggest} /></I18nProvider>)
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "Lav en regning til Nordlys" } })
    fireEvent.change(input, { target: { value: "En anden opgave" } })
    await act(async () => {})
    expect(screen.queryByRole("region")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Bed quits" }))
    expect(screen.getByRole("region").textContent).toContain("En anden opgave")
    expect(screen.getByRole("status").textContent).toContain("Foreslåede felter")
  })

  it("grows into the card slot for a request, and Annuller hands the cursor back", () => {
    const { input, submit } = renderBar()
    fireEvent.change(input, { target: { value: "vis forfaldne" } })
    expect(submit.disabled).toBe(false)

    fireEvent.click(submit)
    const slot = screen.getByRole("region", { name: "Opgave" })
    expect(slot.textContent).toContain("vis forfaldne")
    expect(document.activeElement).toBe(slot)

    fireEvent.click(screen.getByRole("button", { name: "Annuller" }))
    expect(screen.queryByRole("region")).toBeNull()
    expect(input.value).toBe("")
    expect(document.activeElement).toBe(input)
  })

  it("keeps the text editable with a card open: editing lets go of the card, and Ryd empties it", () => {
    const { input, submit } = renderBar()
    fireEvent.change(input, { target: { value: "vis forfaldne" } })
    fireEvent.click(submit)
    expect(input.readOnly).toBe(false)

    fireEvent.change(input, { target: { value: "vis forfald" } })
    expect(screen.queryByRole("region")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Ryd" }))
    expect(input.value).toBe("")
    expect(document.activeElement).toBe(input)
  })

  it("opens the card another part of the page asks for, and leaves an open one alone", () => {
    const { input } = renderBar()
    act(() => announceRequestOpen({ kind: "overdue", input: "Forfaldne fakturaer" }))
    expect(input.value).toBe("Forfaldne fakturaer")
    expect(screen.getByRole("region", { name: "Opgave" })).toBeTruthy()

    act(() => announceRequestOpen({ kind: "overdue", input: "noget andet" }))
    expect(input.value).toBe("Forfaldne fakturaer")
  })

  it("closes the card on Escape", () => {
    const { input, submit } = renderBar()
    fireEvent.change(input, { target: { value: "vis forfaldne" } })
    fireEvent.click(submit)

    fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" })
    expect(screen.queryByRole("region")).toBeNull()
    expect(document.activeElement).toBe(input)
  })

  it("offers a request only to those who may do what its card does", () => {
    const { input, submit } = renderBar(action => action === "invoice:send")
    fireEvent.change(input, { target: { value: "faktura til Nordlys 5 timer à 850" } })
    expect(submit.disabled).toBe(true)
    fireEvent.change(input, { target: { value: "vis forfaldne" } })
    expect(submit.disabled).toBe(false)

    cleanup()
    const { input: other, submit: otherSubmit } = renderBar(action => action === "invoice:create")
    fireEvent.change(other, { target: { value: "vis forfaldne" } })
    expect(otherSubmit.disabled).toBe(true)
  })

  it("never animates every property, not even through the shadcn button default", () => {
    const { input, submit } = renderBar()
    fireEvent.change(input, { target: { value: "vis forfaldne" } })
    fireEvent.click(submit)

    const classes = [...document.querySelectorAll("[class]")].map((element) => element.getAttribute("class"))
    expect(classes.some((value) => /(^|\s)transition-all(\s|$)/.test(value ?? ""))).toBe(false)
  })
})
