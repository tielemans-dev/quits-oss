// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

const api = vi.hoisted(() => ({
  creditNotesList: vi.fn(),
  creditNotesCapabilities: vi.fn(),
  remindersList: vi.fn(),
  remindersCapabilities: vi.fn(),
}))

vi.mock("../../../../trpc/client", () => ({
  trpc: {
    creditNotes: {
      list: { query: api.creditNotesList },
      capabilities: { query: api.creditNotesCapabilities },
    },
    reminders: {
      listForInvoice: { query: api.remindersList },
      capabilities: { query: api.remindersCapabilities },
    },
  },
}))

vi.mock("../../../../lib/i18n/react", () => ({
  useI18n: () => ({ locale: "en-US", t: (key: string) => key }),
}))

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: unknown }) => children,
}))

vi.mock("../../../credit-notes/create-credit-note-dialog", () => ({
  CreateCreditNoteDialog: () => null,
}))

vi.mock("../../../credit-notes/credit-notes-table", () => ({
  CreditNotesTable: () => null,
}))

import { InvoiceCreditNotesPanel } from "../credit-notes-panel"
import { InvoiceRemindersPanel } from "../reminders-panel"
import type { InvoicePanelInvoice } from "../types"

const invoice: InvoicePanelInvoice = {
  id: "inv_1",
  number: "INV-0001",
  status: "sent",
  paymentStatus: "unpaid",
  currency: "DKK",
  total: 1000,
  amountPaid: 0,
  amountCredited: 0,
  balanceDue: 1000,
  dueDate: "2099-01-01",
  contact: { id: "c_1", name: "Acme", email: "acme@example.com" },
}

const onChanged = async () => undefined

beforeEach(() => {
  api.creditNotesList.mockResolvedValue([])
  api.remindersList.mockResolvedValue({
    remindersPaused: false,
    policyEnabled: true,
    remindable: true,
    hasRecipient: true,
    reminders: [],
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("invoice lifecycle panels by role", () => {
  it("offers a member credit notes, reminder sending, and pausing", async () => {
    api.creditNotesCapabilities.mockResolvedValue({ canCreate: true, canSend: true })
    api.remindersCapabilities.mockResolvedValue({ canSendNow: true, canPause: true, canUpdatePolicy: false })

    render(
      <>
        <InvoiceCreditNotesPanel invoice={invoice} onChanged={onChanged} />
        <InvoiceRemindersPanel invoice={invoice} onChanged={onChanged} />
      </>
    )

    expect(await screen.findByRole("button", { name: /creditNotes.action.create/ })).toBeTruthy()
    expect(await screen.findByRole("button", { name: /reminders.panel.sendNow/ })).toBeTruthy()
    await waitFor(() =>
      expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false)
    )
  })

  it("shows an accountant credit notes and reminders read-only", async () => {
    api.creditNotesCapabilities.mockResolvedValue({ canCreate: false, canSend: false })
    api.remindersCapabilities.mockResolvedValue({ canSendNow: false, canPause: false, canUpdatePolicy: false })

    render(
      <>
        <InvoiceCreditNotesPanel invoice={invoice} onChanged={onChanged} />
        <InvoiceRemindersPanel invoice={invoice} onChanged={onChanged} />
      </>
    )

    expect(await screen.findByText("creditNotes.panel.readOnly")).toBeTruthy()
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement
    await waitFor(() => expect(api.remindersCapabilities).toHaveBeenCalled())
    expect(checkbox.disabled).toBe(true)
    expect(screen.queryByRole("button", { name: /creditNotes.action.create/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /reminders.panel.sendNow/ })).toBeNull()
  })
})
