// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  get: vi.fn(),
  settings: vi.fn(),
  capabilities: vi.fn(),
}))

const auth = vi.hoisted(() => ({
  session: { data: { session: { activeOrganizationId: "org_a" } }, isPending: false },
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ creditNoteId: "cn_1" }),
  }),
  Link: ({ children }: { children: unknown }) => children,
}))

vi.mock("../../trpc/client", () => ({
  trpc: {
    creditNotes: {
      get: { query: api.get },
      capabilities: { query: api.capabilities },
      send: { mutate: vi.fn() },
    },
    settings: { get: { query: api.settings } },
  },
}))

vi.mock("../../lib/auth-client", () => ({
  useSession: () => auth.session,
}))

vi.mock("../../lib/i18n/react", () => ({
  useI18n: () => ({ locale: "en-US", t: translate }),
}))

import { Route } from "../_app/credit-notes/$creditNoteId"

function translate(key: string) {
  return key
}

const RouteComponent = (Route as unknown as { component: ComponentType }).component

const creditNote = {
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
  lastEmailAttemptAt: null,
  lastEmailAttemptOutcome: null,
}

const settings = {
  companyName: "Nordic ApS",
  companyEmail: null,
  companyPhone: null,
  companyAddress: null,
  companyLogo: null,
  locale: "en-US",
  timezone: "UTC",
  emailDelivery: { available: true },
}

beforeEach(() => {
  api.get.mockResolvedValue(creditNote)
  api.settings.mockResolvedValue(settings)
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  auth.session = { data: { session: { activeOrganizationId: "org_a" } }, isPending: false }
})

describe("credit note detail capabilities", () => {
  it("hides sending as soon as the user switches to an organization where they may not send", async () => {
    api.capabilities.mockResolvedValueOnce({ canCreate: true, canSend: true })
    const { rerender } = render(<RouteComponent />)
    expect(await screen.findByRole("button", { name: /creditNotes.action.send/ })).toBeTruthy()

    let resolve!: (value: { canCreate: boolean; canSend: boolean }) => void
    api.capabilities.mockReturnValueOnce(new Promise((done) => (resolve = done)))
    auth.session = { data: { session: { activeOrganizationId: "org_b" } }, isPending: false }
    rerender(<RouteComponent />)

    expect(screen.queryByRole("button", { name: /creditNotes.action.send/ })).toBeNull()
    await act(async () => resolve({ canCreate: false, canSend: false }))
    expect(screen.queryByRole("button", { name: /creditNotes.action.send/ })).toBeNull()
    expect(api.capabilities).toHaveBeenCalledTimes(2)
  })

  it("offers sending after switching to an organization where the user may send", async () => {
    api.capabilities.mockResolvedValueOnce({ canCreate: false, canSend: false })
    const { rerender } = render(<RouteComponent />)
    expect(await screen.findByText("creditNotes.detail.title")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /creditNotes.action.send/ })).toBeNull()

    api.capabilities.mockResolvedValueOnce({ canCreate: true, canSend: true })
    auth.session = { data: { session: { activeOrganizationId: "org_b" } }, isPending: false }
    rerender(<RouteComponent />)

    expect(await screen.findByRole("button", { name: /creditNotes.action.send/ })).toBeTruthy()
    await waitFor(() => expect(api.capabilities).toHaveBeenCalledTimes(2))
  })
})
