// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"

const api = vi.hoisted(() => ({
  creditNotesList: vi.fn(),
  creditNotesCapabilities: vi.fn(),
  remindersList: vi.fn(),
  remindersCapabilities: vi.fn(),
}))

const auth = vi.hoisted(() => ({
  session: { data: { session: { activeOrganizationId: "org_a" } }, isPending: false },
}))

vi.mock("../../../../lib/auth-client", () => ({
  useSession: () => auth.session,
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
  auth.session = { data: { session: { activeOrganizationId: "org_a" } }, isPending: false }
})

const memberCapabilities = {
  creditNotes: { canCreate: true, canSend: true },
  reminders: { canSendNow: true, canPause: true, canUpdatePolicy: false },
}
const accountantCapabilities = {
  creditNotes: { canCreate: false, canSend: false },
  reminders: { canSendNow: false, canPause: false, canUpdatePolicy: false },
}

function panels() {
  return (
    <>
      <InvoiceCreditNotesPanel invoice={invoice} onChanged={onChanged} />
      <InvoiceRemindersPanel invoice={invoice} onChanged={onChanged} />
    </>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("invoice lifecycle panels by role", () => {
  it("offers a member credit notes, reminder sending, and pausing", async () => {
    api.creditNotesCapabilities.mockResolvedValue({ canCreate: true, canSend: true })
    api.remindersCapabilities.mockResolvedValue({ canSendNow: true, canPause: true, canResume: true, canUpdatePolicy: false })

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

  it("lets a role that cannot send pause reminders but not resume them", async () => {
    api.creditNotesCapabilities.mockResolvedValue({ canCreate: false, canSend: false })
    api.remindersCapabilities.mockResolvedValue({
      canSendNow: false,
      canPause: true,
      canResume: false,
      canUpdatePolicy: false,
    })
    api.remindersList.mockResolvedValue({
      remindersPaused: true,
      policyEnabled: true,
      remindable: true,
      hasRecipient: true,
      reminders: [],
    })

    render(<InvoiceRemindersPanel invoice={invoice} onChanged={onChanged} />)

    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement
    await waitFor(() => expect(api.remindersCapabilities).toHaveBeenCalled())
    expect(checkbox.checked).toBe(true)
    expect(checkbox.disabled).toBe(true)
  })

  it("shows an accountant credit notes and reminders read-only", async () => {
    api.creditNotesCapabilities.mockResolvedValue({ canCreate: false, canSend: false })
    api.remindersCapabilities.mockResolvedValue({ canSendNow: false, canPause: false, canResume: false, canUpdatePolicy: false })

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

  it("hides member controls as soon as the user switches to an organization where they are an accountant", async () => {
    api.creditNotesCapabilities.mockResolvedValueOnce(memberCapabilities.creditNotes)
    api.remindersCapabilities.mockResolvedValueOnce(memberCapabilities.reminders)
    const { rerender } = render(panels())
    expect(await screen.findByRole("button", { name: /creditNotes.action.create/ })).toBeTruthy()
    expect(await screen.findByRole("button", { name: /reminders.panel.sendNow/ })).toBeTruthy()

    const creditNotes = deferred<typeof accountantCapabilities.creditNotes>()
    const reminders = deferred<typeof accountantCapabilities.reminders>()
    api.creditNotesCapabilities.mockReturnValueOnce(creditNotes.promise)
    api.remindersCapabilities.mockReturnValueOnce(reminders.promise)
    // setActive() + router.invalidate() keep the panels mounted; only the session changes.
    auth.session = { data: { session: { activeOrganizationId: "org_b" } }, isPending: false }
    rerender(panels())

    // Nothing is allowed while the new organization's capabilities load.
    expect(screen.queryByRole("button", { name: /creditNotes.action.create/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /reminders.panel.sendNow/ })).toBeNull()
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true)

    await act(async () => {
      creditNotes.resolve(accountantCapabilities.creditNotes)
      reminders.resolve(accountantCapabilities.reminders)
    })
    expect(await screen.findByText("creditNotes.panel.readOnly")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /reminders.panel.sendNow/ })).toBeNull()
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true)
    expect(api.creditNotesCapabilities).toHaveBeenCalledTimes(2)
    expect(api.remindersCapabilities).toHaveBeenCalledTimes(2)
  })

  it("shows member controls after switching from an accountant organization", async () => {
    api.creditNotesCapabilities.mockResolvedValueOnce(accountantCapabilities.creditNotes)
    api.remindersCapabilities.mockResolvedValueOnce(accountantCapabilities.reminders)
    const { rerender } = render(panels())
    expect(await screen.findByText("creditNotes.panel.readOnly")).toBeTruthy()

    api.creditNotesCapabilities.mockResolvedValueOnce(memberCapabilities.creditNotes)
    api.remindersCapabilities.mockResolvedValueOnce(memberCapabilities.reminders)
    auth.session = { data: { session: { activeOrganizationId: "org_b" } }, isPending: false }
    rerender(panels())

    expect(await screen.findByRole("button", { name: /creditNotes.action.create/ })).toBeTruthy()
    expect(await screen.findByRole("button", { name: /reminders.panel.sendNow/ })).toBeTruthy()
    await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false))
  })
})
