// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  quoteId: "q_1",
  get: vi.fn(),
  settings: vi.fn(),
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ quoteId: state.quoteId }),
    useSearch: () => ({}),
  }),
  Link: ({ children }: { children: unknown }) => children,
  useNavigate: () => vi.fn(),
}))

vi.mock("../../trpc/client", () => ({
  trpc: {
    quotes: { get: { query: state.get } },
    settings: { get: { query: state.settings } },
  },
}))

vi.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: { session: { activeOrganizationId: "org_a" } }, isPending: false }),
}))

vi.mock("../../lib/i18n/react", () => ({
  useI18n: () => ({ locale: "en-US", t: translate }),
}))

function translate(key: string) {
  return key
}

import { Route } from "../_app/quotes/$quoteId"

const RouteComponent = (Route as unknown as { component: ComponentType }).component

function quote(id: string, number: string, outcome: string | null = null) {
  return {
    id,
    number,
    status: "sent",
    issueDate: "2026-10-01T00:00:00.000Z",
    expiryDate: "2026-10-31T00:00:00.000Z",
    subtotal: 100,
    taxAmount: 0,
    total: 100,
    currency: "DKK",
    notes: null,
    publicViewUrl: null,
    publicDecisionAt: null,
    publicRejectionReason: null,
    lastEmailAttemptAt: outcome ? "2026-10-02T00:00:00.000Z" : null,
    lastEmailAttemptOutcome: outcome,
    lastEmailAttemptCode: null,
    lastEmailAttemptMessage: null,
    contact: {
      id: "c_1",
      name: "Acme",
      email: "acme@example.com",
      company: null,
      address: null,
      city: null,
      state: null,
      zip: null,
      country: null,
    },
    items: [],
    invoices: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  state.quoteId = "q_1"
  state.settings.mockResolvedValue({ emailDelivery: { available: true } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe("quote detail page responses", () => {
  it("ignores a slow load for the previous quote after navigating to another", async () => {
    const first = deferred<ReturnType<typeof quote>>()
    state.get.mockImplementation(({ id }: { id: string }) =>
      id === "q_1" ? first.promise : Promise.resolve(quote("q_2", "Q-0002"))
    )

    const view = render(<RouteComponent />)
    state.quoteId = "q_2"
    view.rerender(<RouteComponent />)

    expect((await screen.findAllByText(/Q-0002/)).length).toBeGreaterThan(0)

    await act(async () => {
      first.resolve(quote("q_1", "Q-0001"))
      await first.promise
    })
    expect(screen.queryAllByText(/Q-0001/)).toHaveLength(0)
    expect(screen.getAllByText(/Q-0002/).length).toBeGreaterThan(0)
  })

  it("stops following delivery and offers a reload when the organization changed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const conflict = Object.assign(new Error("The active organization changed; reload and try again"), {
      data: { code: "CONFLICT" },
    })
    state.get.mockResolvedValueOnce(quote("q_1", "Q-0001", "sending")).mockRejectedValue(conflict)

    render(<RouteComponent />)
    expect((await screen.findAllByText(/Q-0001/)).length).toBeGreaterThan(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(state.get).toHaveBeenCalledTimes(2)
    expect(screen.getByText("The active organization changed; reload and try again")).toBeTruthy()
    const reload = screen.getByRole("button", { name: "ui.reloadRequired.action" })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(state.get).toHaveBeenCalledTimes(2)

    const reloadSpy = vi.fn()
    Object.defineProperty(window, "location", { value: { ...window.location, reload: reloadSpy }, configurable: true })
    fireEvent.click(reload)
    expect(reloadSpy).toHaveBeenCalled()
  })
})
