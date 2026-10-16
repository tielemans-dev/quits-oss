// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { notifyMutation } from "../../../../lib/query-refresh"

const api = vi.hoisted(() => ({ list: vi.fn(), capabilities: vi.fn() }))
vi.mock("../../../../trpc/client", () => ({ trpc: { creditNotes: { list: { query: api.list }, capabilities: { query: api.capabilities } } } }))
vi.mock("../../../../lib/auth-client", () => ({ useSession: () => ({ data: { session: { activeOrganizationId: "org_1" } }, isPending: false }) }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("../../../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("../../../credit-notes/credit-notes-table", () => ({ CreditNotesTable: ({ creditNotes }: { creditNotes: { number: string }[] }) => <p>{creditNotes.map(note => note.number).join(",")}</p> }))
vi.mock("../../../credit-notes/create-credit-note-dialog", () => ({ CreateCreditNoteDialog: () => null }))
import { InvoiceCreditNotesPanel } from "../credit-notes-panel"
import type { InvoicePanelInvoice } from "../types"
const invoice = { id: "inv_1", status: "sent", total: 100, currency: "DKK" } as InvoicePanelInvoice

afterEach(() => { cleanup(); vi.resetAllMocks() })

it("retains loaded credit notes and offers retry after a transient refresh failure", async () => {
  api.list.mockResolvedValue([{ id: "cn_1", number: "CN-0001", status: "issued", total: 10 }])
  api.capabilities.mockResolvedValue({ canCreate: false })
  render(<InvoiceCreditNotesPanel invoice={invoice} locale="en-US" onChanged={vi.fn()} />)
  await screen.findByText("CN-0001")
  api.list.mockRejectedValueOnce(new Error("Credit notes unavailable"))
  await act(async () => notifyMutation("creditNotes.issue", null))
  await screen.findByText("Credit notes unavailable")
  expect(screen.getByText("CN-0001")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "ui.retry" }))
  await screen.findByText("CN-0001")
  expect(screen.queryByText("Credit notes unavailable")).toBeNull()
})

it("hides credit notes only when access is explicitly denied", async () => {
  api.list.mockRejectedValue(Object.assign(new Error("Denied"), { data: { code: "FORBIDDEN" } }))
  api.capabilities.mockResolvedValue({ canCreate: false })
  const { container } = render(<InvoiceCreditNotesPanel invoice={invoice} locale="en-US" onChanged={vi.fn()} />)
  await act(async () => {})
  expect(container.innerHTML).toBe("")
})
