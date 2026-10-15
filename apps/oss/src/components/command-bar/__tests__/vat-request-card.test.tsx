// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
const api = vi.hoisted(() => ({ overview: vi.fn(), export: vi.fn(), handoff: vi.fn() }))
vi.mock("../../../trpc/client", () => ({ trpc: { exports: { vatOverview: { query: api.overview } } } }))
vi.mock("../../jobs/reminder-jobs-store", () => ({ exportVat: api.export }))
vi.mock("../tracker-handoff", () => ({ handOffToTracker: api.handoff }))
import { I18nProvider } from "../../../lib/i18n/react"
import { VatRequestCard } from "../vat-request-card"
import { permittedRequest, recognizeRequest } from "../request-intent"
const open = () => render(<I18nProvider locale="da-DK"><div data-slot="request-card-slot"><VatRequestCard intent={{ kind: "vat", input: "vis moms" }} onDismiss={vi.fn()} /></div></I18nProvider>)
afterEach(() => { cleanup(); vi.resetAllMocks() })
it("recognizes a VAT request in either entry point and requires export permission", () => {
  expect(recognizeRequest("vis moms")?.kind).toBe("vat")
  expect(recognizeRequest("momsoversigt")?.kind).toBe("vat")
  expect(recognizeRequest("Momsfirma ApS")).toBeNull()
  expect(permittedRequest(recognizeRequest, () => false)("vis moms")).toBeNull()
})
it("shows exact sales VAT without inventing purchase VAT or filing, then queues only on click", async () => {
  api.overview.mockResolvedValue({ available: true, period: { label: "Q3", from: "2026-07-01", to: "2026-09-30", date: "2026-12-01" }, outputVatMinor: "7501" })
  open(); await screen.findByText("Salgsmoms")
  expect(screen.getAllByText("Ikke opgjort")).toHaveLength(2)
  expect(screen.getByText(/Intet er indberettet/)).toBeTruthy()
  expect(api.handoff).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Eksportér til TastSelv" }))
  await api.handoff.mock.calls[0]![1]()
  expect(api.export).toHaveBeenCalledWith("2026-07-01", expect.any(String))
})
it.each(["registration", "period", "currency"])("withholds the export when unavailable: %s", async reason => {
  api.overview.mockResolvedValue({ available: false, reason }); open()
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull())
  expect(screen.queryByRole("button", { name: "Eksportér til TastSelv" })).toBeNull()
})
