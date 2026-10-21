// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  get: vi.fn(),
  settings: vi.fn(),
  capabilities: vi.fn(),
  issueDraft: vi.fn(),
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
      issueDraft: { mutate: api.issueDraft },
      discardDraft: { mutate: vi.fn() },
      send: { mutate: vi.fn() },
    },
    settings: { get: { query: api.settings } },
  },
}))

vi.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { session: { activeOrganizationId: "org_a" } }, isPending: false }),
}))

vi.mock("../../lib/i18n/react", () => ({
  useI18n: () => ({ locale: "da-DK", t: translate }),
}))

import { Route } from "../_app/credit-notes/$creditNoteId"
import { handledMutationError } from "../../lib/query-refresh"

function translate(key: string) {
  return key
}

const RouteComponent = (Route as unknown as { component: ComponentType }).component

const draft = {
  id: "cn_1",
  number: "CN-0001",
  status: "draft",
  currency: "DKK",
  countryCode: "DK",
  timezone: "UTC",
  issueDate: "2026-10-01T00:00:00.000Z",
  sellerSnapshot: { companyName: "Nordlys ApS", companyAddress: "Sællervej 1\n9000 Aalborg" },
  buyerSnapshot: null,
  contact: { id: "c_1", name: "Kunde ApS", company: "Kunde ApS", email: "kunde@example.test", address: "Testvej 1", city: "Aarhus C", zip: "8000", country: "DK" },
  invoice: { id: "inv_1", number: "INV-0001", issueDate: "2026-09-01T00:00:00.000Z" },
  items: [],
  subtotal: 100,
  taxAmount: 0,
  total: 100,
  reason: "Fejl i antal",
  lastEmailAttemptAt: null,
  lastEmailAttemptOutcome: null,
}
const issued = { ...draft, status: "issued" }

beforeEach(() => {
  api.get.mockResolvedValue(draft)
  api.capabilities.mockResolvedValue({ canCreate: true, canSend: true })
  api.settings.mockResolvedValue({ locale: "da-DK", timezone: "UTC", emailDelivery: { available: false } })
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

const downloadButton = () => screen.getByRole("button", { name: /creditNotes.action.downloadPdf/ }) as HTMLButtonElement

describe("issuing a credit note draft", () => {
  it("shows the issued credit note without a reload", async () => {
    let finish!: () => void
    api.issueDraft.mockReturnValueOnce(new Promise<void>((done) => (finish = done)))
    render(<RouteComponent />)
    fireEvent.click(await screen.findByRole("button", { name: "creditNotes.action.issue" }))

    expect((screen.getByRole("button", { name: "creditNotes.action.issuing" }) as HTMLButtonElement).disabled).toBe(true)
    expect(downloadButton().disabled).toBe(true)

    api.get.mockResolvedValue(issued)
    finish()

    await vi.waitFor(() => expect(downloadButton().disabled).toBe(false))
    expect(screen.queryByRole("button", { name: /creditNotes.action.issu/ })).toBeNull()
    expect(api.issueDraft).toHaveBeenCalledWith({ id: "cn_1" }, handledMutationError)
  })

  it("shows what was stored when the answer is lost after issuing", async () => {
    render(<RouteComponent />)
    api.issueDraft.mockRejectedValueOnce(new Error("Network error"))
    api.get.mockResolvedValue(issued)
    fireEvent.click(await screen.findByRole("button", { name: "creditNotes.action.issue" }))

    await vi.waitFor(() => expect(downloadButton().disabled).toBe(false))
    expect(screen.getByRole("alert").textContent).toBe("Network error")
    expect(screen.queryByRole("button", { name: /creditNotes.action.issu/ })).toBeNull()
  })
})

describe("credit note parties", () => {
  it("shows the seller and names the customer once, with the postcode before the city", async () => {
    api.get.mockResolvedValue(issued)
    render(<RouteComponent />)

    expect(await screen.findByText("Nordlys ApS")).toBeTruthy()
    expect(screen.getAllByText("Kunde ApS")).toHaveLength(1)
    expect(screen.getByText("8000 Aarhus C")).toBeTruthy()
    // A Danish customer of a Danish seller needs no country line, as on the invoice page.
    expect(screen.queryByText("DK")).toBeNull()
    // A credit note is not a bill, so the block is not headed "Fakturer til".
    expect(screen.getByRole("heading", { name: translate("creditNotes.detail.customer") })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: translate("pdf.billTo") })).toBeNull()
  })
})
