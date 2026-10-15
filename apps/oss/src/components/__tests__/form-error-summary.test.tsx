// @vitest-environment jsdom
import { createRef } from "react"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"
import { FormErrorSummary } from "../form-error-summary"

afterEach(cleanup)
describe.each([
  ["da-DK", "1 ting mangler, før du kan fortsætte", "2 ting mangler, før du kan fortsætte", "Klik på et punkt for at gå til feltet."],
  ["en-GB", "1 thing to fix before you can continue", "2 things to fix before you can continue", "Click an item to jump to the field."],
])("error summary in %s", (locale, one, other, hint) => {
  it("waits for submit, focuses on each failure, links fields and clears without stealing focus", () => {
    const scope = createRef<HTMLDivElement>()
    const errors = [{ target: "#customer", label: "Customer", message: "Choose a customer" }, { target: "#email", label: "Email", message: "Enter an email" }]
    const ui = (attempt: number, remaining = errors) => <I18nProvider locale={locale}><div ref={scope}>
      <FormErrorSummary scope={scope} attempt={attempt} errors={remaining} />
      <input id="customer" aria-label="Customer" /><input id="email" aria-label="Email" />
    </div></I18nProvider>
    const view = render(ui(0))
    expect(screen.queryByRole("alert")).toBeNull()
    view.rerender(ui(1))
    const summary = screen.getByRole("alert", { name: other })
    expect(document.activeElement).toBe(summary)
    expect(within(summary).getByText(hint)).toBeTruthy()
    fireEvent.click(within(summary).getByRole("link", { name: "Email: Enter an email" }))
    expect(document.activeElement).toBe(screen.getByLabelText("Email"))
    view.rerender(ui(1, errors.slice(1)))
    expect(screen.getByRole("alert", { name: one })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText("Email"))
    view.rerender(ui(2, errors.slice(1)))
    expect(document.activeElement).toBe(summary)
    view.rerender(ui(2, []))
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
