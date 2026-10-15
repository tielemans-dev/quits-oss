// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  locale: "en-US",
  quoteId: "q_1",
  get: vi.fn(),
  settings: vi.fn(),
  download: vi.fn(),
}))
vi.mock("../../lib/documents-download", () => ({ downloadDocumentPdf: state.download }))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ quoteId: state.quoteId }),
    useSearch: () => ({}),
  }),
  Link: ({ children, params }: { children: React.ReactNode; params: { invoiceId?: string; contactId?: string } }) => <a href={params.invoiceId ? `/invoices/${params.invoiceId}` : `/contacts/${params.contactId}`}>{children}</a>,
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
  useI18n: () => ({ locale: state.locale, t: translate }),
}))

import { translate as catalogTranslate } from "../../lib/i18n/translate"
function translate(key: Parameters<typeof catalogTranslate>[0], vars?: Record<string, string | number>) {
  return catalogTranslate(key, state.locale, vars)
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
    countryCode: "DK",
    timezone: "Europe/Copenhagen",
    notes: null,
    publicViewUrl: null,
    publicDecisionAt: null,
    publicRejectionReason: null,
    lastEmailAttemptAt: outcome ? "2026-10-02T00:00:00.000Z" : null,
    lastEmailAttemptOutcome: outcome,
    lastEmailAttemptCode: outcome === "sent" ? "sent" : null,
    lastEmailAttemptMessage: outcome ? "Test delivery status" : null,
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
  state.locale = "en-US"
  state.quoteId = "q_1"
  state.settings.mockResolvedValue({ emailDelivery: { available: true } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe("quote detail page responses", () => {
  it("downloads the quote PDF and lets the user retry a failed download", async () => {
    state.get.mockResolvedValue(quote("q_1", "Q-0001"))
    const download = deferred<void>()
    state.download.mockReturnValueOnce(download.promise).mockRejectedValueOnce(new Error("Unavailable"))
    render(<RouteComponent />)
    fireEvent.click(await screen.findByRole("button", { name: "Download PDF" }))
    const pending = await screen.findByRole("button", { name: "Downloading PDF..." })
    expect((pending as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { download.resolve(); await download.promise })
    expect(state.download).toHaveBeenCalledWith("quote", "q_1", "Q-0001")
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }))
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not download the PDF. Try again.")
    expect((screen.getByRole("button", { name: "Download PDF" }) as HTMLButtonElement).disabled).toBe(false)
  })
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
    const reload = screen.getByRole("button", { name: catalogTranslate("ui.reloadRequired.action", "en-US") })

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

// MOCK: synthetic quote responses exercise presentation only; no production imports or customers.
describe.each(["da-DK", "en-US"])("quote detail polish in %s", (locale) => {
  it("uses final copy, short dates, Danish postal order and a flat email section", async () => {
    state.locale = locale
    const data = quote("q_1", "Q-0001", "sent")
    data.issueDate = "2026-10-11T12:00:00Z"
    data.lastEmailAttemptAt = "2026-10-11T12:00:00Z"
    Object.assign(data.contact, { address: "Testvej 2", zip: "9000", city: "Aalborg", country: "DK" })
    state.get.mockResolvedValue(data)
    const { container } = render(<RouteComponent />)
    const da = locale === "da-DK"
    await screen.findByText("9000 Aalborg")
    expect(screen.queryByText("Aalborg, 9000")).toBeNull()
    expect(screen.queryByText("Danmark")).toBeNull()
    expect(screen.queryByText("DK")).toBeNull()
    expect(screen.getAllByText(da ? "11. okt. 2026" : "11 Oct 2026").length).toBeGreaterThan(0)
    expect(screen.getByText(da ? "Tilbudsdato:" : "Quote date:")).toBeTruthy()
    expect(screen.getByText(da ? "Gyldigt til:" : "Valid until:")).toBeTruthy()
    expect(screen.getByText(da ? "Send tilbuddet til kunden på e-mail." : "Email the quote to your customer.")).toBeTruthy()
    expect(screen.getByText(da ? "Sendt 11. okt. 2026" : "Sent 11 Oct 2026")).toBeTruthy()
    expect(screen.getByText(da ? "E-mailen med tilbuddet er sendt." : "The quote email was sent.")).toBeTruthy()
    expect(container.querySelectorAll('[data-slot="card"] [data-slot="card"]').length).toBe(0)
  })

  it.each(["INV-0002", null])("links to the converted invoice with number %s or draft copy", async (number) => {
    state.locale = locale
    state.get.mockResolvedValue({ ...quote("q_1", "Q-0001"), status: "accepted", invoices: [{ id: "inv_2", number }] })
    render(<RouteComponent />)
    const text = number ? (locale === "da-DK" ? "Faktureret som INV-0002" : "Invoiced as INV-0002") : (locale === "da-DK" ? "Faktureret som kladde" : "Invoiced as a draft")
    expect((await screen.findByRole("link", { name: text })).getAttribute("href")).toBe("/invoices/inv_2")
    expect(screen.getByText(locale === "da-DK" ? "Tilbuddet er allerede faktureret, så det kan ikke laves om til en aftale." : "This quote is already invoiced, so it can't become an agreement.")).toBeTruthy()
  })
})
