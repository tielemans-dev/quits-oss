// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../lib/i18n/react"
const mock = vi.hoisted(() => ({ settings: vi.fn(), agreement: vi.fn(), save: vi.fn(), navigate: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mock.navigate }))
vi.mock("../../trpc/client", () => ({ trpc: {
  agreements: { capabilities: { query: async () => ({ depositsEnabled: false }) }, listTemplates: { query: async () => [] }, get: { query: mock.agreement }, createDraftDecimal: { mutate: mock.save }, updateDraftDecimal: { mutate: mock.save } },
  contacts: { list: { query: async () => [] } }, settings: { get: { query: mock.settings } },
} }))
import { AgreementEditor } from "../_app/agreements/-editor"
afterEach(cleanup)
beforeEach(() => { vi.clearAllMocks(); mock.save.mockResolvedValue({ id: "saved" }) })
function show(agreementId?: string) { render(<I18nProvider locale="en-US"><AgreementEditor agreementId={agreementId} /></I18nProvider>) }
async function save() {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Synthetic work" } })
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }))
  await waitFor(() => expect(mock.save).toHaveBeenCalled())
  return mock.save.mock.calls[0]![0]
}
describe("agreement editor tax defaults", () => {
  it.each([[20, undefined, "custom", "20"], [7.5, undefined, "us_sales_tax", "7.5"], [25, true, "eu_vat", "25"], [25, false, "eu_vat", "0"], [0, undefined, "custom", "0"], [null, undefined, "custom", "0"], [19, false, "custom", "19"]])("uses configured %s rate and registration %s under %s", async (taxRate, momsRegistered, taxRegime, expected) => {
    mock.settings.mockResolvedValue({ defaultCurrency: "DKK", taxRate, momsRegistered, taxRegime, pricesIncludeTax: true })
    show()
    const input = await screen.findByLabelText("Tax rate (%)") as HTMLInputElement
    expect(input.value).toBe(expected)
    fireEvent.change(input, { target: { value: "12.5" } })
    expect(input.value).toBe("12.5")
  })
  it("keeps a saved zero rate and explicit outside-VAT line despite changed organization defaults", async () => {
    mock.settings.mockResolvedValue({ defaultCurrency: "DKK", taxRate: 25, taxRegime: "eu_vat", pricesIncludeTax: true })
    mock.agreement.mockResolvedValue({ status: "draft", offerFormatVersion: 2, sellerSnapshot: {}, contactId: "buyer", title: "Saved", termsMarkdown: "Saved terms", templateId: null, validUntil: new Date("2099-01-01"), currency: "DKK", taxRateInput: "0", taxRate: 0, dueInDays: 30, billingTrigger: "on_delivery", pricesIncludeTax: false, deliverables: [{ title: "Saved work", description: "", quantity: 1, unitPriceNet: 100, unitPriceGross: 100, vatTreatment: "out_of_scope", vatRateInput: "0", vatCountry: null, vatReasonCode: null, taxRate: 0 }] })
    show("saved")
    expect((await screen.findByLabelText("Tax rate (%)") as HTMLInputElement).value).toBe("0")
    const input = await save()
    expect(input.taxRate).toBe("0")
    expect(input.deliverables[0].vat).toEqual({ treatment: "out_of_scope", rate: "0", country: null, reasonCode: null })
    expect(input.termsMarkdown).toBe("Saved terms")
  })
})
