// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { I18nProvider } from "../../../lib/i18n/react"
import { CommandBar } from "../command-bar"
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
  it("does nothing for text that is not a request", () => {
    const { input, submit } = renderBar()
    fireEvent.change(input, { target: { value: "nordlys" } })

    expect(submit.disabled).toBe(true)
    fireEvent.submit(input.closest("form")!)
    expect(screen.queryByRole("region")).toBeNull()
  })

  it("grows into the card slot for a request, and Annuller hands the cursor back", () => {
    const { input, submit } = renderBar()
    fireEvent.change(input, { target: { value: "vis forfaldne" } })
    expect(submit.disabled).toBe(false)

    fireEvent.click(submit)
    const slot = screen.getByRole("region", { name: "Opgave" })
    expect(slot.textContent).toContain("vis forfaldne")
    expect(input.readOnly).toBe(true)
    expect(document.activeElement).toBe(slot)

    fireEvent.click(screen.getByRole("button", { name: "Annuller" }))
    expect(screen.queryByRole("region")).toBeNull()
    expect(input.readOnly).toBe(false)
    expect(input.value).toBe("")
    expect(document.activeElement).toBe(input)
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
