// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const api = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  sendNow: vi.fn(),
}))

vi.mock("../../../../lib/auth-client", () => ({
  useSession: () => ({ data: { session: { activeOrganizationId: "org_a" } }, isPending: false }),
}))

vi.mock("../../../../trpc/client", () => ({
  trpc: {
    reminders: {
      listForInvoice: { query: api.list },
      capabilities: { query: api.capabilities },
      sendNow: { mutate: api.sendNow },
    },
  },
}))

vi.mock("../../../../lib/i18n/react", () => ({
  useI18n: () => ({ locale: "en-US", t: translate }),
}))

// A stable translate function, as the real i18n context provides.
function translate(key: string) {
  return key
}

import { InvoiceRemindersPanel, reminderDelivery } from "../reminders-panel"
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

const onChanged = vi.fn(async () => undefined)

beforeEach(() => {
  api.list.mockResolvedValue({
    remindersPaused: false,
    policyEnabled: true,
    remindable: true,
    hasRecipient: true,
    reminders: [],
  })
  api.capabilities.mockResolvedValue({ canSendNow: true, canPause: true, canResume: true, canUpdatePolicy: false })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function clickSendNow() {
  render(<InvoiceRemindersPanel invoice={invoice} onChanged={onChanged} />)
  const button = await screen.findByRole("button", { name: "reminders.panel.sendNow" })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  const loadsBefore = api.list.mock.calls.length
  fireEvent.click(button)
  return loadsBefore
}

describe("InvoiceRemindersPanel send now", () => {
  it.each([
    ["sent", "reminders.panel.sent"],
    ["pending", "reminders.panel.pending"],
    ["unconfirmed", "reminders.panel.unconfirmed"],
  ])("reports a %s reminder and refreshes the history", async (delivery, message) => {
    api.sendNow.mockResolvedValue({ reminderId: "r_1", recipient: "acme@example.com", delivery })
    const loadsBefore = await clickSendNow()

    expect(await screen.findByText(message)).toBeTruthy()
    expect(api.list.mock.calls.length).toBeGreaterThan(loadsBefore)
    for (const other of ["reminders.panel.sent", "reminders.panel.pending", "reminders.panel.unconfirmed"]) {
      if (other !== message) expect(screen.queryByText(other)).toBeNull()
    }
  })

  it("shows a refused reminder's error and refreshes the history", async () => {
    api.sendNow.mockRejectedValue(new Error("The provider refused the reminder"))
    const loadsBefore = await clickSendNow()

    expect((await screen.findByRole("alert")).textContent).toBe("The provider refused the reminder")
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThan(loadsBefore))
    expect(screen.queryByText("reminders.panel.sent")).toBeNull()
  })

  it("reads results from a server without a delivery field as sent", () => {
    expect(reminderDelivery({ reminderId: "r_1", recipient: "a@b.c", sentAt: new Date() })).toBe("sent")
    expect(reminderDelivery({ delivery: "pending" })).toBe("pending")
    expect(reminderDelivery({ delivery: "unconfirmed" })).toBe("unconfirmed")
  })
})
