// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { I18nProvider } from "../../../lib/i18n/react"
import { FlowPreview } from "../flow-preview"

afterEach(cleanup)

// MOCK: a synthetic CVR customer as the customer list returns it; 24256790 passes the CVR check digit.
const customer = {
  name: "Anna Jensen", email: "anna@example.test", company: "MOCK Nordlys ApS", taxId: "24256790",
  address: "Vestergade 5", zip: "8000", city: "Aarhus C", state: null, country: "DK",
}

it("shows the buyer as the saved draft does: legal name, CVR and billing address", () => {
  render(<I18nProvider locale="da-DK"><FlowPreview customer={customer} company="MOCK Seller ApS" sellerCountry="DK" dueDate="" currency="DKK" items={[]} total={null} paymentMethods={[]} /></I18nProvider>)
  const panel = screen.getByRole("tabpanel")
  for (const line of ["Anna Jensen", "MOCK Nordlys ApS", "CVR-nr. 24256790", "Vestergade 5", "8000 Aarhus C"]) {
    expect(panel.textContent).toContain(line)
  }
  // A Danish seller leaves "Danmark" off a Danish buyer, as the saved draft does.
  expect(panel.textContent).not.toContain("Danmark")
})

it("asks for a customer before one is chosen", () => {
  render(<I18nProvider locale="en-US"><FlowPreview company="MOCK Seller ApS" dueDate="" currency="DKK" items={[]} total={null} paymentMethods={[]} /></I18nProvider>)
  expect(screen.getByRole("tabpanel").textContent).not.toContain("CVR")
})
