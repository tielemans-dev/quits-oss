// @vitest-environment jsdom
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { I18nProvider } from "../../lib/i18n/react"
// MOCK: transport responses and route context only. The edit form, error mapping and catalogs are real.
const api = vi.hoisted(() => ({ get: vi.fn(), settings: vi.fn(), update: vi.fn() }))
vi.mock("../../trpc/client", () => ({ trpc: {
  invoices: { get: { query: api.get }, updateV2: { mutate: api.update }, sendReadiness: { query: async () => ({ issues: [], warnings: [], taxRate: "25", baseCurrency: "DKK" }) } }, settings: { get: { query: api.settings } },
  contacts: { list: { query: async () => [{ id: "buyer", name: "Synthetic buyer" }] } }, catalog: { list: { query: async () => [] } },
  paymentDetails: { firstSendReadiness: { query: async () => ({ bankMissing: false }) } },
} }))
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ ...options, useParams: () => ({ invoiceId: "draft" }), useSearch: () => ({}) }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}))
vi.mock("../../components/billing/trial-access", () => ({ useTrialAccess: () => null, isReadOnly: () => false, PaywallBlock: () => null }))
vi.mock("../../components/invoices/panels", () => ({ InvoiceLifecyclePanels: () => null }))
import { Route } from "../_app/invoices/$invoiceId"
const Detail = (Route as unknown as { component: () => ReactNode }).component
const draft = {
  id: "draft", number: null, status: "draft", paymentStatus: "unpaid", purpose: "sale", currency: "DKK", taxRegime: "eu_vat",
  dueDate: "2026-11-09", issueDate: "2026-10-13", supplyDate: "2026-10-13", total: 0, subtotal: 0, taxAmount: 0,
  items: [{ id: "i1", description: "Work", quantity: 1, unitPrice: 100, taxRate: 0 }, { id: "i2", description: "More", quantity: 1, unitPrice: 50, taxRate: 0 }],
  contact: { id: "buyer", name: "Synthetic buyer", email: "buyer@example.test" }, sellerSnapshot: { countryCode: "DK", momsRegistered: false },
}
const rawJson = JSON.stringify([
  { origin: "string", code: "too_small", path: ["items", 0, "description"], message: "Too small: expected string to have >=1 characters" },
  { code: "invalid_type", path: ["items", 0, "quantity"], message: "Invalid input" },
  { code: "weird", path: ["somethingElse"], message: "raw" },
])
beforeEach(() => {
  vi.resetAllMocks()
  api.get.mockResolvedValue(draft)
  api.settings.mockResolvedValue({ baseCurrency: "DKK", emailDelivery: { available: true } })
})
afterEach(cleanup)

describe.each([
  ["da-DK", { edit: "Rediger", notes5000: "Højst 5000 tegn", cancel: "Annuller", save: "Gem ændringer", description: "Beskriv, hvad du fakturerer for", qty: "Indtast et antal, fx 1 eller 2,5", price: "Indtast en pris, fx 1250,00", unknown: "Tjek feltet og prøv igen", failed: "Vi kunne ikke gemme lige nu. Prøv igen om et øjeblik.", addLine: "Tilføj vare" }],
  ["en-GB", { edit: "Edit", notes5000: "5000 characters max", cancel: "Cancel", save: "Save Changes", description: "Describe what you're invoicing for", qty: "Enter a quantity, like 1 or 2.5", price: "Enter a price, like 1250.00", unknown: "Check this field and try again", failed: "We couldn't save right now. Try again in a moment.", addLine: "Add Item" }],
])("invoice edit validation messages in %s", (locale, copy) => {
  // The next save stays in flight until the returned function fails it.
  function failLater() {
    let reject: (error: Error) => void = () => {}
    api.update.mockReturnValue(new Promise((_, fail) => { reject = fail }))
    return (errors: object[]) => reject(new Error(JSON.stringify(errors)))
  }
  async function openEditor() {
    render(<I18nProvider locale={locale}><Detail /></I18nProvider>)
    fireEvent.click(await screen.findByRole("button", { name: copy.edit }))
    return await screen.findByRole("button", { name: copy.save })
  }

  it("shows readable inline messages instead of raw JSON, and clears each once its field is edited", async () => {
    api.update.mockRejectedValue(new Error(rawJson))
    fireEvent.click(await openEditor())
    expect(await screen.findByText(copy.description)).toBeTruthy()
    expect(screen.getByText(copy.qty)).toBeTruthy()
    expect(screen.getByText(copy.unknown)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Too small|Invalid input|"path"|\[\{/)
    fireEvent.change(screen.getByDisplayValue("Work"), { target: { value: "Consulting" } })
    expect(screen.queryByText(copy.description)).toBeNull()
    expect(screen.getByText(copy.qty)).toBeTruthy()
  })

  it("does not show the previous attempt's errors after cancelling and reopening", async () => {
    api.update.mockRejectedValue(new Error(rawJson))
    fireEvent.click(await openEditor())
    await screen.findByText(copy.description)
    fireEvent.click(screen.getByRole("button", { name: copy.cancel }))
    fireEvent.click(await screen.findByRole("button", { name: copy.edit }))
    await screen.findByRole("button", { name: copy.save })
    expect(screen.queryByText(copy.description)).toBeNull()
    expect(screen.queryByText(copy.unknown)).toBeNull()
  })

  it("ties each message to its control and routes notes errors to the notes field", async () => {
    api.update.mockRejectedValue(new Error(JSON.stringify([
      { code: "too_small", path: ["items", 0, "description"] },
      { origin: "string", code: "too_big", maximum: 5000, path: ["notes"] },
      { code: "too_small", path: ["contactId"] },
    ])))
    fireEvent.click(await openEditor())
    const notes = await screen.findByText(copy.notes5000)
    expect(notes.closest("#edit-notes-error")).not.toBeNull()
    const [work] = [screen.getByDisplayValue("Work")]
    expect(work.getAttribute("aria-invalid")).toBe("true")
    expect(document.getElementById(work.getAttribute("aria-describedby")!)?.textContent).toBe(copy.description)
    expect(screen.getByDisplayValue("More").getAttribute("aria-invalid")).toBeNull()
    expect(document.getElementById("edit-contact-error")).not.toBeNull()
    expect(document.querySelector("[aria-describedby='edit-contact-error']")).not.toBeNull()
    fireEvent.change(document.getElementById("editNotes")!, { target: { value: "short" } })
    expect(screen.queryByText(copy.notes5000)).toBeNull()
  })

  it("drops a deleted row's errors and keeps later rows' errors on their own row", async () => {
    api.update.mockRejectedValue(new Error(JSON.stringify([{ code: "too_small", path: ["items", 0, "quantity"] }, { code: "too_small", path: ["items", 1, "description"] }])))
    fireEvent.click(await openEditor())
    await screen.findByText(copy.description)
    const trash = () => screen.getAllByRole("button").filter((button) => button.innerHTML.includes("lucide-trash"))
    fireEvent.click(trash()[0])
    expect(screen.queryByText(copy.qty)).toBeNull()
    const more = screen.getByDisplayValue("More")
    expect(more.getAttribute("aria-invalid")).toBe("true")
    expect(document.getElementById(more.getAttribute("aria-describedby")!)?.textContent).toBe(copy.description)
  })

  it("describes each line control only by its own column's message", async () => {
    api.update.mockRejectedValue(new Error(JSON.stringify([{ code: "too_small", path: ["items", 0, "description"] }, { code: "invalid_type", path: ["items", 0, "unitPrice"] }])))
    fireEvent.click(await openEditor())
    await screen.findByText(copy.description)
    const describedText = (element: HTMLElement) => element.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent).join(" | ")
    expect(describedText(screen.getByDisplayValue("Work"))).toBe(copy.description)
    expect(describedText(screen.getByDisplayValue("100"))).toBe(copy.price)
  })

  it("keeps earlier server issues when a retry stops at the local quantity check", async () => {
    api.update.mockRejectedValue(new Error(JSON.stringify([{ origin: "string", code: "too_big", maximum: 5000, path: ["notes"] }])))
    const save = await openEditor()
    fireEvent.click(save)
    await screen.findByText(copy.notes5000)
    fireEvent.change(document.getElementById("invoice-edit-quantity-0")!, { target: { value: "1e3" } })
    fireEvent.click(save)
    expect(screen.getByText(copy.notes5000)).toBeTruthy()
    expect(api.update).toHaveBeenCalledTimes(1)
  })

  it("keeps a late failure's errors for fields that did not change while it was in flight", async () => {
    const reject = failLater()
    fireEvent.click(await openEditor())
    fireEvent.change(document.getElementById("editNotes")!, { target: { value: "edited" } })
    reject([{ code: "too_small", path: ["items", 0, "description"] }])
    expect(await screen.findByText(copy.description)).toBeTruthy()
  })

  it("keeps a late line error when only another column of that row changed or a row was added", async () => {
    const reject = failLater()
    fireEvent.click(await openEditor())
    fireEvent.change(document.getElementById("invoice-edit-quantity-0")!, { target: { value: "3" } })
    fireEvent.click(screen.getAllByRole("button").find((button) => button.textContent === copy.addLine)!)
    reject([{ code: "too_small", path: ["items", 0, "description"] }])
    const work = screen.getByDisplayValue("Work")
    await waitFor(() => expect(work.getAttribute("aria-invalid")).toBe("true"))
    expect(screen.getByText(copy.description)).toBeTruthy()
    expect(screen.queryByText(copy.failed)).toBeNull()
  })

  const trash = () => screen.getAllByRole("button").filter((button) => button.innerHTML.includes("lucide-trash"))
  const priceError = [{ code: "invalid_type", path: ["items", 1, "unitPrice"] }]

  it("keeps a late price error on its row when a row is added and an earlier row deleted during the save", async () => {
    const reject = failLater()
    fireEvent.click(await openEditor())
    fireEvent.click(screen.getAllByRole("button").find((button) => button.textContent === copy.addLine)!)
    fireEvent.click(trash()[0])
    reject(priceError)
    const price = await screen.findByDisplayValue("50")
    await waitFor(() => expect(price.getAttribute("aria-invalid")).toBe("true"))
    expect(document.getElementById(price.getAttribute("aria-describedby")!)?.textContent).toBe(copy.price)
    expect(screen.getAllByText(copy.price)).toHaveLength(1)
  })

  it("focuses and scrolls to the first invalid control after a failed save", async () => {
    const scrollIntoView = (Element.prototype.scrollIntoView = vi.fn())
    api.update.mockRejectedValue(new Error(JSON.stringify([
      { origin: "string", code: "too_big", maximum: 5000, path: ["notes"] },
      { code: "too_small", path: ["items", 1, "description"] },
      { code: "invalid_type", path: ["items", 1, "unitPrice"] },
    ])))
    fireEvent.click(await openEditor())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByDisplayValue("More")))
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it("keeps the editor open when the user edited while a successful save was in flight", async () => {
    let resolve: (value: unknown) => void = () => {}
    api.update.mockReturnValue(new Promise((done) => { resolve = done }))
    fireEvent.click(await openEditor())
    fireEvent.change(screen.getByDisplayValue("Work"), { target: { value: "Consulting" } })
    resolve(draft)
    await waitFor(() => expect(screen.getByRole("button", { name: copy.save }).hasAttribute("disabled")).toBe(false))
    expect(screen.getByDisplayValue("Consulting")).toBeTruthy()
  })

  it("clears a line-count error when the row count changes", async () => {
    api.update.mockRejectedValue(new Error(JSON.stringify([{ code: "too_big", path: ["items"] }])))
    fireEvent.click(await openEditor())
    const message = await screen.findByText(copy.unknown)
    expect(message.closest("#edit-items-error")).not.toBeNull()
    fireEvent.click(screen.getAllByRole("button").filter((button) => button.innerHTML.includes("lucide-trash"))[0])
    expect(screen.queryByText(copy.unknown)).toBeNull()
  })

  it("ignores a failed save's errors when the form changed while it was in flight", async () => {
    const reject = failLater()
    fireEvent.click(await openEditor())
    fireEvent.change(screen.getByDisplayValue("Work"), { target: { value: "Consulting" } })
    reject([{ code: "too_small", path: ["items", 0, "description"] }])
    await waitFor(() => expect(screen.getByRole("button", { name: copy.save }).hasAttribute("disabled")).toBe(false))
    expect(screen.queryByText(copy.description)).toBeNull()
  })

  it("keeps plain-text server messages and uses the save fallback for non-errors", async () => {
    api.update.mockRejectedValueOnce(new Error("Invoice is not editable"))
    fireEvent.click(await openEditor())
    expect((await screen.findByRole("alert")).textContent).toBe("Invoice is not editable")
    api.update.mockRejectedValueOnce("boom")
    fireEvent.click(screen.getByRole("button", { name: copy.save }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(copy.failed))
  })
})
