// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Dialog } from "radix-ui"
const api = vi.hoisted(() => ({ list: vi.fn(), lookup: vi.fn(), create: vi.fn(), remove: vi.fn() }))
vi.mock("../../../trpc/client", () => ({ trpc: {
  contacts: { list: { query: api.list }, create: { mutate: api.create }, undoCreate: { mutate: api.remove } },
  cvr: { customer: { query: api.lookup } },
} }))
vi.mock("../invoice-request-card", () => ({ InvoiceRequestCard: ({ initialContactId }: { initialContactId: string }) => <p>Invoice draft: {initialContactId}</p> }))
import { I18nProvider } from "../../../lib/i18n/react"
import { CustomerRequestCard } from "../customer-request-card"
import { recognizeRequest, permittedRequest } from "../request-intent"
const company = { cvr: "24256790", name: "Firma ApS", address: "Gade 1, 8000 Aarhus", statusClass: "active" }
const open = (input = "24256790") => render(<I18nProvider locale="da-DK"><CustomerRequestCard intent={{ kind: "customer", input }} onDismiss={vi.fn()} /></I18nProvider>)
beforeEach(() => { api.list.mockResolvedValue([]); api.lookup.mockResolvedValue(company); api.create.mockResolvedValue({ id: "new", reused: false }); api.remove.mockResolvedValue({}) })
afterEach(() => { cleanup(); vi.resetAllMocks() })
it("recognizes CVR input without replacing ordinary search and requires customer permissions", () => {
  expect(recognizeRequest("24256790")?.kind).toBe("customer")
  expect(recognizeRequest("ny kunde 123")?.kind).toBe("customer")
  expect(recognizeRequest("nordlys")).toBeNull()
  expect(recognizeRequest("123456789")).toBeNull()
  expect(permittedRequest(recognizeRequest, action => action === "invoice:create")("24256790")).toBeNull()
})
it("looks up without writing, then creates only on click and offers undo", async () => {
  open(); await screen.findByText(company.name)
  expect(screen.getByText(company.address)).toBeTruthy()
  expect(api.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Opret kunde og faktura" }))
  await screen.findByText("Invoice draft: new")
  expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ name: company.name, taxId: company.cvr, country: "DK", reuseCvr: true }))
  fireEvent.click(screen.getByRole("button", { name: "Fortryd" }))
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ id: "new" }))
  await screen.findByRole("button", { name: "Opret kunde og faktura" })
})
it("offers an existing taxId match even without a lookup provider", async () => {
  api.list.mockResolvedValue([{ id: "old", name: "Existing", taxId: "DK 24256790", address: "Saved address" }])
  open(); await screen.findByText("Existing")
  expect(api.lookup).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Brug kunde og opret faktura" }))
  await screen.findByText("Invoice draft: old")
  expect(api.create).not.toHaveBeenCalled()
  expect(screen.queryByRole("button", { name: "Fortryd" })).toBeNull()
})
it.each([null, "invalid", "unavailable"])("explains lookup failures: %s", async mode => {
  if (mode === "unavailable") api.lookup.mockRejectedValue({ data: { code: "NOT_IMPLEMENTED" } })
  else api.lookup.mockResolvedValue(null)
  open(mode === "invalid" ? "ny kunde 123" : undefined)
  await screen.findByRole("alert")
  expect(api.create).not.toHaveBeenCalled()
  expect(screen.queryByRole("button", { name: "Opret kunde og faktura" })).toBeNull()
})
it("keeps the company on failed create, and the draft on refused undo", async () => {
  api.create.mockRejectedValueOnce(new Error("offline")); api.remove.mockRejectedValue(new Error("in use"))
  open(); await screen.findByText(company.name)
  fireEvent.click(screen.getByRole("button", { name: "Opret kunde og faktura" }))
  await screen.findByRole("alert")
  fireEvent.click(screen.getByRole("button", { name: "Opret kunde og faktura" }))
  await screen.findByText("Invoice draft: new")
  fireEvent.click(screen.getByRole("button", { name: "Fortryd" }))
  await screen.findByRole("alert")
  expect(screen.getByText("Invoice draft: new")).toBeTruthy()
})
it("keeps undo inside a modal's focus trap", async () => {
  render(<Dialog.Root open><Dialog.Portal><Dialog.Content aria-describedby={undefined}><Dialog.Title>Command palette</Dialog.Title><I18nProvider locale="da-DK"><CustomerRequestCard intent={{ kind: "customer", input: "24256790" }} onDismiss={vi.fn()} /></I18nProvider></Dialog.Content></Dialog.Portal></Dialog.Root>)
  await screen.findByText(company.name)
  fireEvent.click(screen.getByRole("button", { name: "Opret kunde og faktura" }))
  const undo = await screen.findByRole("button", { name: "Fortryd" })
  expect(screen.getByRole("dialog").contains(undo)).toBe(true)
  fireEvent.click(undo)
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ id: "new" }))
})
