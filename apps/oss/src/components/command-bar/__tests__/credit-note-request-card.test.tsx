// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi, beforeEach } from "vitest"
const api = vi.hoisted(() => ({ find: vi.fn(), availability: vi.fn(), create: vi.fn(), discard: vi.fn() }))
vi.mock("../../../trpc/client", () => ({ trpc: { creditNotes: {
  findInvoice: { query: api.find }, availability: { query: api.availability }, createDraft: { mutate: api.create }, discardDraft: { mutate: api.discard },
} } }))
import { I18nProvider } from "../../../lib/i18n/react"
import { CreditNoteRequestCard } from "../credit-note-request-card"
import { recognizeRequest, permittedRequest } from "../request-intent"
import { computeCreditAvailability } from "../../../lib/credit-notes/calculation"
import { resetRequestDataForTesting } from "../request-data"

// Cards share their reads for a few seconds; every test starts without them.
beforeEach(() => resetRequestDataForTesting())

afterEach(() => { cleanup(); vi.resetAllMocks() })
it("recognizes invoice numbers without replacing ordinary search or bypassing permissions", () => {
  expect(recognizeRequest("kreditnota 2026-041")?.kind).toBe("creditNote")
  expect(recognizeRequest("nordlys")).toBeNull()
  expect(recognizeRequest("kreditnota 2026-041 send den")).toBeNull()
  expect(permittedRequest(recognizeRequest, () => false)("kreditnota 2026-041")).toBeNull()
})
it("previews exact partial credit, creates only on click, and undoes only the created draft", async () => {
  const line = { id: "l", description: "Arbejde", quantity: 3, unitPriceNet: 0.03, unitPriceGross: 0.04, lineNet: 0.09, lineTax: 0.02, lineGross: 0.11, taxRate: 25, taxCategory: "standard", taxCode: null }
  api.find.mockResolvedValue({ id: "inv" })
  api.availability.mockResolvedValue({ invoiceId: "inv", invoiceNumber: "2026-041", customerName: "Nordlys", currency: "DKK", taxRate: 25,
    availability: computeCreditAvailability({ lines: [line], priorCredits: [], totalNet: 0.09, totalTax: 0.02, totalGross: 0.11, creditedNet: 0, creditedTax: 0, creditedGross: 0 }) })
  api.create.mockResolvedValue({ id: "cn", number: "CN-0001" }); api.discard.mockResolvedValue({ id: "cn" })
  render(<I18nProvider locale="da-DK"><CreditNoteRequestCard intent={{ kind: "creditNote", input: "kreditnota 2026-041" }} onDismiss={vi.fn()} /></I18nProvider>)
  const quantity = await screen.findByLabelText("Arbejde")
  expect(api.create).not.toHaveBeenCalled()
  fireEvent.change(quantity, { target: { value: "1" } })
  expect(document.body.textContent?.replace(/\u00a0/g, " ")).toContain("-0,04 kr.")
  fireEvent.change(screen.getByLabelText("Årsagstekst (valgfri)"), { target: { value: "Rettet antal" } })
  fireEvent.click(screen.getByRole("button", { name: "Opret kreditnota" }))
  await screen.findByRole("button", { name: "Fortryd" })
  expect(api.create).toHaveBeenCalledWith({ selection: { invoiceId: "inv", mode: "lines", reason: "Fejl i antal: Rettet antal", lines: [{ invoiceItemId: "l", quantity: 1 }] }, clientRequestId: expect.any(String) })
  fireEvent.click(screen.getByRole("button", { name: "Fortryd" }))
  await waitFor(() => expect(screen.queryByRole("button", { name: "Fortryd" })).toBeNull())
  expect(api.discard).toHaveBeenCalledWith({ id: "cn" })
})
