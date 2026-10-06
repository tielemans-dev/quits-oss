// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  creditNoteId: "cn_1",
  get: vi.fn(),
  settings: vi.fn(),
  capabilities: vi.fn(),
  send: vi.fn(),
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ creditNoteId: api.creditNoteId }),
  }),
  Link: ({ children }: { children: unknown }) => children,
}))

vi.mock("../../trpc/client", () => ({
  trpc: {
    creditNotes: {
      get: { query: api.get },
      capabilities: { query: api.capabilities },
      send: { mutate: api.send },
    },
    settings: { get: { query: api.settings } },
  },
}))

vi.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { session: { activeOrganizationId: "org_a" } }, isPending: false }),
}))

vi.mock("../../lib/i18n/react", () => ({
  useI18n: () => ({ locale: "en-US", t: translate }),
}))

import { Route } from "../_app/credit-notes/$creditNoteId"

/** The key, followed by the document number where one is shown (to tell credit notes apart). */
function translate(key: string, params?: Record<string, unknown>) {
  return key === "creditNotes.detail.title" ? `${key} ${String(params?.number)}` : key
}

const RouteComponent = (Route as unknown as { component: ComponentType }).component

const base = {
  id: "cn_1",
  number: "CN-0001",
  currency: "DKK",
  timezone: "UTC",
  issueDate: "2026-10-01T00:00:00.000Z",
  buyerSnapshot: null,
  contact: { id: "c_1", name: "Acme", email: "acme@example.com" },
  invoice: { id: "inv_1", number: "INV-0001", issueDate: "2026-09-01T00:00:00.000Z" },
  items: [],
  subtotal: 100,
  taxAmount: 0,
  total: 100,
  reason: "Returned",
}

const sending = { ...base, lastEmailAttemptAt: "2026-10-02T00:00:00.000Z", lastEmailAttemptOutcome: "sending" }
const sent = { ...base, lastEmailAttemptAt: "2026-10-02T00:00:00.000Z", lastEmailAttemptOutcome: "sent" }

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  api.settings.mockResolvedValue({
    companyName: "Nordic ApS",
    companyEmail: null,
    companyPhone: null,
    companyAddress: null,
    companyLogo: null,
    locale: "en-US",
    timezone: "UTC",
    emailDelivery: { available: true },
  })
  api.capabilities.mockResolvedValue({ canCreate: true, canSend: true })
})

afterEach(() => {
  cleanup()
  api.creditNoteId = "cn_1"
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe("credit note detail while the email is being delivered", () => {
  it("disables resending and reloads until delivery settles", async () => {
    api.get.mockResolvedValueOnce(sending).mockResolvedValueOnce(sending).mockResolvedValue(sent)
    render(<RouteComponent />)

    const button = (await screen.findByRole("button", { name: "creditNotes.action.resend" })) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText("creditNotes.detail.email.sending")).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(button.disabled).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_500)
    })
    expect(api.get).toHaveBeenCalledTimes(3)
    expect(screen.getByText("creditNotes.detail.email.sent")).toBeTruthy()
    expect((screen.getByRole("button", { name: "creditNotes.action.resend" }) as HTMLButtonElement).disabled).toBe(false)

    // Settled: no more polling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(api.get).toHaveBeenCalledTimes(3)
  })

  it("does not report a queued send as emailed", async () => {
    api.get.mockResolvedValueOnce({ ...base, lastEmailAttemptAt: null, lastEmailAttemptOutcome: null })
    api.get.mockResolvedValue(sending)
    api.send.mockResolvedValue({
      id: "cn_1",
      recipient: "acme@example.com",
      attemptedAt: new Date("2026-10-02T00:00:00.000Z"),
      delivery: "pending",
    })
    render(<RouteComponent />)

    const button = await screen.findByRole("button", { name: "creditNotes.action.send" })
    await act(async () => {
      button.click()
    })

    expect(await screen.findByText("creditNotes.detail.email.pending")).toBeTruthy()
    expect(screen.queryByText("creditNotes.detail.email.success")).toBeNull()
  })

  it("keeps showing the next credit note when an earlier send settles", async () => {
    const creditNotes: Record<string, typeof base> = {
      cn_1: { ...base, lastEmailAttemptAt: null, lastEmailAttemptOutcome: null } as typeof base,
      cn_2: { ...base, id: "cn_2", number: "CN-0002", lastEmailAttemptAt: null, lastEmailAttemptOutcome: null } as typeof base,
    }
    api.get.mockImplementation(async ({ id }: { id: string }) => creditNotes[id])
    let settleSend: (value: unknown) => void = () => undefined
    api.send.mockReturnValue(new Promise((resolve) => (settleSend = resolve)))

    const view = render(<RouteComponent />)
    expect(await screen.findByText("creditNotes.detail.title CN-0001")).toBeTruthy()
    const send = screen.getByRole("button", { name: "creditNotes.action.send" })
    await act(async () => {
      send.click()
    })
    expect(api.send).toHaveBeenCalledWith({ id: "cn_1" })

    // Navigate to another credit note while the first one is still being sent.
    api.creditNoteId = "cn_2"
    view.rerender(<RouteComponent />)
    expect(await screen.findByText("creditNotes.detail.title CN-0002")).toBeTruthy()
    const loadsBeforeSettling = api.get.mock.calls.length

    await act(async () => {
      settleSend({ id: "cn_1", recipient: "acme@example.com", attemptedAt: new Date(), delivery: "sent" })
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(screen.getByText("creditNotes.detail.title CN-0002")).toBeTruthy()
    expect(screen.queryByText("creditNotes.detail.title CN-0001")).toBeNull()
    expect(screen.queryByText("creditNotes.detail.email.success")).toBeNull()
    // The first send's follow-up reload is skipped rather than restoring the first credit note.
    expect(api.get.mock.calls.slice(loadsBeforeSettling)).toEqual([])
    expect((screen.getByRole("button", { name: "creditNotes.action.send" }) as HTMLButtonElement).disabled).toBe(false)
  })
})
