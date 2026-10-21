// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, expect, it } from "vitest"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import { I18nProvider } from "../../lib/i18n/react"
import { DocumentVatFields } from "../document-vat-fields"

afterEach(cleanup)

function Fields({ initial, onLines, buyerCountry }: { initial: DocumentLineInput[]; onLines: (lines: DocumentLineInput[]) => void; buyerCountry?: string }) {
  const [items, setItems] = useState(initial)
  return <DocumentVatFields items={items} onItemsChange={lines => { setItems(lines); onLines(lines) }} taxRate="25" defaultCountry="DK" buyerCountry={buyerCountry} evidence={{}} onEvidenceChange={() => {}} />
}

function renderFields(initial: DocumentLineInput[], buyerCountry?: string) {
  const seen: DocumentLineInput[][] = []
  render(<I18nProvider initialLocale="da-DK"><Fields initial={initial} buyerCountry={buyerCountry} onLines={lines => seen.push(lines)} /></I18nProvider>)
  return { last: () => seen.at(-1) ?? [] }
}

const line = { description: "Rådgivning", quantity: "1", unitPrice: "100" }

it("enters the line VAT rate as a percentage and keeps the stored fraction", () => {
  const { last } = renderFields([{ ...line, vat: { treatment: "standard", rate: "0.125", country: "DK", reasonCode: null } }])
  const rate = screen.getByLabelText("Momssats for linje 1") as HTMLInputElement
  expect(screen.getByText("Momssats (%)")).toBeTruthy()
  expect(rate.value).toBe("12,5")
  fireEvent.change(rate, { target: { value: "25" } })
  expect(last()[0]?.vat?.rate).toBe("0.25")
  expect(rate.value).toBe("25")
  // A decimal comma mid-entry is kept as typed.
  fireEvent.change(rate, { target: { value: "12," } })
  expect(rate.value).toBe("12,")
  expect(last()[0]?.vat?.rate).toBe("0.12")
})

it("shows the organization's country for a line without one and sets it for a domestic treatment", () => {
  const { last } = renderFields([{ ...line, vat: { treatment: "out_of_scope", rate: "0", country: null, reasonCode: null } }])
  fireEvent.change(screen.getByLabelText("Momsbehandling for linje 1"), { target: { value: "standard" } })
  expect(last()[0]?.vat).toMatchObject({ treatment: "standard", rate: "0.25", country: "DK" })
  expect((screen.getByLabelText("Momssats for linje 1") as HTMLInputElement).value).toBe("25")
})

it("shows the organization's country as the default of an empty VAT country", () => {
  renderFields([line])
  expect(screen.getByPlaceholderText("DK")).toBeTruthy()
})

it.each([
  ["a Danish customer", "DK", "DK", false],
  ["a Danish customer, line set to another country", "DK", "SE", true],
  ["a Swedish customer", "SE", "DK", true],
  ["an unknown customer", undefined, "DK", true],
])("shows the VAT country to a Danish seller for %s: %s", (_name, buyerCountry, country, shown) => {
  renderFields([{ ...line, vat: { treatment: "standard", rate: "0.25", country, reasonCode: null } }], buyerCountry)
  expect(Boolean(screen.queryByText("Momsland (ISO-kode)"))).toBe(shown)
})
