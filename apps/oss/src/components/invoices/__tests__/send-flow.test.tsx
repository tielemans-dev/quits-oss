// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to, params }: { children: React.ReactNode; to: string; params?: { section?: string } }) => <a href={params?.section ? to.replace("$section", params.section) : to}>{children}</a> }))
import { I18nProvider } from "../../../lib/i18n/react"
import { LineVatSelect } from "../line-vat-select"
import { OrganizationGaps } from "../organization-gaps"
import { SendConfirmation } from "../send-confirmation"
import { PriceBasisToggle } from "../price-basis-toggle"
import { CountrySelect } from "../../country-select"
import { invoiceIssueKey } from "../../../lib/invoice-field-issues"
import { translate } from "../../../lib/i18n/translate"

afterEach(cleanup)
const line = { description: "Work", quantity: "1", unitPrice: "100" }
describe("invoice send controls", () => {
  it("lets keyboard users choose the draft price basis", () => {
    const onChange = vi.fn()
    render(<I18nProvider locale="da-DK"><PriceBasisToggle value={false} onChange={onChange} /></I18nProvider>)
    const exclusive = screen.getByRole("radio", { name: "Ekskl. moms" })
    const inclusive = screen.getByRole("radio", { name: "Inkl. moms" })
    expect(exclusive.getAttribute("aria-checked")).toBe("true")
    exclusive.focus()
    fireEvent.keyDown(exclusive, { key: "ArrowRight" })
    expect(onChange).toHaveBeenCalledWith(true)
    expect(document.activeElement).toBe(inclusive)
  })
  it("defaults DK VAT to 25 percent and stores zero classifications without displaying fractions", () => {
    const onChange = vi.fn()
    render(<I18nProvider locale="da-DK"><LineVatSelect item={line} taxRate="25" index={0} onChange={onChange} /></I18nProvider>)
    const control = screen.getByRole("combobox")
    expect((control as HTMLSelectElement).value).toBe("standard")
    expect(screen.getByRole("option", { name: "25 %" })).toBeTruthy()
    expect(screen.queryByText("0.25")).toBeNull()
    fireEvent.change(control, { target: { value: "exempt" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ treatment: "exempt", rate: "0" }))
    fireEvent.change(control, { target: { value: "out_of_scope" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ treatment: "out_of_scope", rate: "0", country: null }))
  })
  it("presents an ordinary restricted VAT policy as plain text", () => {
    render(<I18nProvider locale="da-DK"><LineVatSelect item={line} taxRate="25" standardVatRate="25" index={0} onChange={vi.fn()} /></I18nProvider>)
    expect(screen.getByText("25 % moms")).toBeTruthy()
    expect(screen.queryByRole("combobox")).toBeNull()
  })
  it("does not mislabel an existing exempt draft as ordinary VAT", () => {
    render(<I18nProvider locale="en-US"><LineVatSelect item={{ ...line, vat: { treatment: "exempt", rate: "0" } }} taxRate="25" standardVatRate="25" index={0} onChange={vi.fn()} /></I18nProvider>)
    expect(screen.queryByText("25 % VAT")).toBeNull()
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true)
  })
  it("combines identity and bank gaps into one card and one action", () => {
    render(<I18nProvider locale="da-DK"><OrganizationGaps issues={[{ code: "cvr.invalid", field: "seller.cvr", params: {} }, { code: "seller.bank.required", field: "seller.bankAccount", params: {} }]} /></I18nProvider>)
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    expect(screen.getAllByRole("link")).toHaveLength(1)
    expect(screen.getByText("Gør dine firmaoplysninger klar")).toBeTruthy()
    expect(screen.getByText("Fakturaen skal vise dit reg.nr. og kontonummer, så kunden kan betale.")).toBeTruthy()
  })
  it.each([
    [[{ code: "required", field: "seller.companyName", params: {} }], "Add your company name", ["Before you can send an invoice", "A CVR number has 8 digits", "Confirm whether you're VAT-registered"]],
    [[{ code: "required", field: "seller.companyAddress", params: {} }], "Add your company's postal address", ["Before you can send an invoice", "Add your company name"]],
    [[{ code: "seller.country.unsupported", field: "seller.countryCode", params: { country: "DK" } }], "Choose a supported country for your company", ["Before you can send an invoice", "Add your company name"]],
    [[{ code: "seller.vatRegistration.required", field: "seller.vatRegistered", params: {} }], "Confirm whether you're VAT-registered", ["Before you can send an invoice", "A CVR number has 8 digits"]],
    [[{ code: "cvr.invalid", field: "seller.cvr", params: {} }], "A CVR number has 8 digits", ["Before you can send an invoice", "Confirm whether you're VAT-registered"]],
  ])("names the seller blocker it is about instead of CVR and VAT instructions: %j", (issues, shown, hidden) => {
    render(<I18nProvider locale="en-US"><OrganizationGaps issues={issues} /></I18nProvider>)
    expect(screen.getByText(shown)).toBeTruthy()
    for (const text of hidden) expect(screen.queryByText(text, { exact: false })).toBeNull()
  })
  it("links seller gaps to the company settings and a bank-only gap to the payment settings", () => {
    const view = render(<I18nProvider locale="en-US"><OrganizationGaps issues={[{ code: "seller.vatRegistration.required", field: "seller.vatRegistered", params: {} }, { code: "seller.bank.required", field: "seller.bankAccount", params: {} }]} /></I18nProvider>)
    expect(screen.getByRole("link").getAttribute("href")).toBe("/settings/company")
    view.rerender(<I18nProvider locale="en-US"><OrganizationGaps issues={[{ code: "seller.bank.required", field: "seller.bankAccount", params: {} }]} /></I18nProvider>)
    expect(screen.getByRole("link").getAttribute("href")).toBe("/settings/payments")
  })
  it("keeps the combined CVR and VAT wording when both are missing", () => {
    render(<I18nProvider locale="en-US"><OrganizationGaps issues={[{ code: "cvr.invalid", field: "seller.cvr", params: {} }, { code: "seller.vatRegistration.required", field: "seller.vatRegistered", params: {} }]} /></I18nProvider>)
    expect(screen.getByText(/needs your CVR number, and you need to confirm whether you're VAT-registered/)).toBeTruthy()
  })
  it("requires an explicit confirmation and disables sending while pending", () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    const view = render(<I18nProvider locale="da-DK"><SendConfirmation open onOpenChange={onOpenChange} number="INV-0002" recipient="buyer@example.test" amount="125,00 kr." dueDate="1. januar 2099" pending={false} onConfirm={onConfirm} /></I18nProvider>)
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Send faktura" }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    view.rerender(<I18nProvider locale="da-DK"><SendConfirmation open onOpenChange={onOpenChange} number="INV-0002" recipient="buyer@example.test" amount="125,00 kr." dueDate="1. januar 2099" pending onConfirm={onConfirm} /></I18nProvider>)
    expect((screen.getByRole("button", { name: "Sender…" }) as HTMLButtonElement).disabled).toBe(true)
  })
  it("defaults the customer country to DK with a localized label", () => {
    render(<I18nProvider locale="da-DK"><CountrySelect id="country" name="country" defaultCountry="DK" /></I18nProvider>)
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("DK")
    expect(screen.getByRole("option", { name: "Danmark" })).toBeTruthy()
  })
  it.each(["20", "19", "7.5"])("restores configured self-host VAT %s from an exempt line", taxRate => {
    const onChange = vi.fn()
    render(<I18nProvider locale="en-US"><LineVatSelect item={{ ...line, vat: { treatment: "exempt", rate: "0" } }} taxRate={taxRate} index={0} onChange={onChange} /></I18nProvider>)
    const control = screen.getByRole("combobox")
    expect(screen.getByRole("option", { name: `${taxRate} % VAT` })).toBeTruthy()
    fireEvent.change(control, { target: { value: "standard" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ treatment: "standard", rate: String(Number(taxRate) / 100) }))
  })
  it("recognizes a non-Danish configured standard rate and preserves exceptional existing rates", () => {
    const view = render(<I18nProvider locale="en-US"><LineVatSelect item={line} taxRate="20" index={0} onChange={vi.fn()} /></I18nProvider>)
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("standard")
    view.rerender(<I18nProvider locale="en-US"><LineVatSelect item={{ ...line, vat: { treatment: "standard", rate: "0.05" } }} taxRate="20" index={0} onChange={vi.fn()} /></I18nProvider>)
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("existing")
    expect(screen.getByRole("option", { name: "Standard · 5 %" })).toBeTruthy()
  })
  it.each(["US", "DE", null, "invalid"])("defaults customer country from organization %s without assuming Denmark", defaultCountry => {
    render(<I18nProvider locale="da-DK"><CountrySelect id="country" name="country" defaultCountry={defaultCountry} /></I18nProvider>)
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(defaultCountry === "US" || defaultCountry === "DE" ? defaultCountry : "")
  })
  it("keeps an existing unset or unknown country and does not overwrite a selection when settings arrive", () => {
    const view = render(<I18nProvider locale="en-US"><CountrySelect id="country" name="country" /></I18nProvider>)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "DE" } })
    view.rerender(<I18nProvider locale="en-US"><CountrySelect id="country" name="country" defaultCountry="DK" /></I18nProvider>)
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("DE")
    view.unmount()
    render(<I18nProvider locale="en-US"><CountrySelect id="country" name="country" value="Legacy country" defaultCountry="DK" /></I18nProvider>)
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("Legacy country")
  })
  it.each(["da-DK", "en-US"])("field errors in %s have no keys or full stops", locale => {
    for (const code of ["required", "customer.required", "cvr.invalid", "customer.businessName.required", "customer.country.unsupported", "unknown"]) {
      const value = translate(invoiceIssueKey(code), locale)
      expect(value).not.toMatch(/[.]$/)
      expect(value).not.toContain("customer.")
    }
  })
  it.each([["0.07", "7"], ["0.14", "14"], ["0.29", "29"], ["0.57", "57"]])("shows an existing %s rate as %s %% without floating-point noise", (rate, shown) => {
    render(<I18nProvider locale="en-US"><LineVatSelect item={{ ...line, vat: { treatment: "standard", rate } }} taxRate="25" index={0} onChange={vi.fn()} /></I18nProvider>)
    expect(screen.getByRole("option", { name: new RegExp(`· ${shown} %$`) })).toBeTruthy()
  })
  it("offers no standard choice when the configured rate is zero", () => {
    render(<I18nProvider locale="en-US"><LineVatSelect item={line} taxRate="0" index={0} onChange={vi.fn()} /></I18nProvider>)
    expect([...(screen.getByRole("combobox") as HTMLSelectElement).options].map(option => option.value)).not.toContain("standard")
  })
  it("presents missing bank details as a status nudge, not an alert, unless they block sending", () => {
    const gap = { code: "seller.bank.required", field: "seller.bankAccount", params: {} }
    const view = render(<I18nProvider locale="en-US"><OrganizationGaps issues={[]} warnings={[gap]} /></I18nProvider>)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByRole("status")).toBeTruthy()
    view.rerender(<I18nProvider locale="en-US"><OrganizationGaps issues={[gap]} /></I18nProvider>)
    expect(screen.getByRole("alert")).toBeTruthy()
  })
})
