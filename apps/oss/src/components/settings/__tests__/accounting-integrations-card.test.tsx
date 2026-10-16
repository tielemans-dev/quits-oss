// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

const api = vi.hoisted(() => ({ status: vi.fn(), disconnect: vi.fn(), retry: vi.fn(), skip: vi.fn(), saveMappings: vi.fn() }))

vi.mock("../../../trpc/client", () => ({
  trpc: { accounting: { status: { query: api.status }, disconnect: { mutate: api.disconnect }, retry: { mutate: api.retry }, skip: { mutate: api.skip }, saveMappings: { mutate: api.saveMappings } } },
}))
vi.mock("../../../lib/auth-client", () => ({
  useSession: () => ({ data: { session: { activeOrganizationId: "org_a" } }, isPending: false }),
}))
vi.mock("../../../lib/i18n/react", async () => {
  const { translate } = await import("../../../lib/i18n/translate")
  const t = (key: string, params?: Record<string, string | number>) => translate(key as never, "en", params)
  return { useI18n: () => ({ t, locale: "en" }) }
})

import { AccountingIntegrationsCard, describeAccountingError } from "../accounting-integrations-card"

const idle = [
  { provider: "economic", status: "not_connected", remoteAccountId: null, delivery: null },
  { provider: "dinero", status: "not_connected", remoteAccountId: null, delivery: null },
]
const dinero = (delivery: object, status = "connected") => [idle[0], { provider: "dinero", status, remoteAccountId: "1234", delivery }]
const clean = { lastDeliveredAt: null, failedCount: 0, pendingCount: 3, backoffCount: 2, lastErrorCode: null }
const load = (providers: object[], canDisconnect = true) => api.status.mockResolvedValue({ providers, canDisconnect })
const confirmDisconnect = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }))
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("AccountingIntegrationsCard", () => {
  it.each(["dinero", "economic"])("shows missing %s mappings, saves edits and keeps them after failure", async provider => {
    const { defaultMappings } = await import("../../../domain/accounting/mappings")
    const providers = [{ ...dinero(clean)[1], provider }]
    Object.assign(providers[0]!, { generation: "g", mappingRevision: "1", mappings: defaultMappings() })
    load(providers)
    api.saveMappings.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ providers, canDisconnect: true })
    render(<AccountingIntegrationsCard />)
    expect(await screen.findByText(/Missing mapping for invoices and credit notes/)).toBeTruthy()
    expect(screen.getByText(/Missing payment account/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Revenue account"), { target: { value: "1000" } })
    fireEvent.change(screen.getByLabelText("VAT code"), { target: { value: "U25" } })
    if (provider === "economic") expect(screen.getByLabelText("Product number")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save mappings" }))
    expect((await screen.findByRole("alert")).textContent).toBe("Could not save mappings. Reload settings and try again.")
    expect((screen.getByLabelText("Revenue account") as HTMLInputElement).value).toBe("1000")
    fireEvent.click(screen.getByRole("button", { name: "Save mappings" }))
    await waitFor(() => expect(api.saveMappings).toHaveBeenCalledTimes(2))
    expect(api.saveMappings).toHaveBeenLastCalledWith(expect.objectContaining({ provider, generation: "g", mappingRevision: "1", mappings: expect.objectContaining({ rows: [expect.objectContaining({ revenueAccount: 1000, vatCode: "U25" })] }) }))
  })
  it("rejects duplicate VAT groups before saving and lets readers view mappings", async () => {
    const { defaultMappings } = await import("../../../domain/accounting/mappings")
    const providers = dinero(clean)
    Object.assign(providers[1]!, { generation: "g", mappingRevision: "1", mappings: defaultMappings() })
    load(providers)
    render(<AccountingIntegrationsCard />)
    fireEvent.click(await screen.findByRole("button", { name: "Add VAT group" }))
    fireEvent.click(screen.getByRole("button", { name: "Add VAT group" }))
    fireEvent.click(screen.getByRole("button", { name: "Save mappings" }))
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(api.saveMappings).not.toHaveBeenCalled()
    cleanup()
    load(providers, false)
    render(<AccountingIntegrationsCard />)
    expect((await screen.findByLabelText("Revenue account")).closest("fieldset")?.disabled).toBe(true)
    expect(screen.queryByRole("button", { name: "Save mappings" })).toBeNull()
  })
  const failed = { ...clean, failedCount: 1, failedDeliveryId: "delivery-1", lastErrorCode: "http_400" }
  it("shows the saved start and an explicit reconnect decision", async () => {
    const providers = dinero({ ...failed, lastErrorCode: "reconnect_review_required" }, "error")
    Object.assign(providers[1]!, { syncStartAt: new Date("2026-10-01T00:00:00Z") })
    load(providers)
    render(<AccountingIntegrationsCard />)
    expect(await screen.findByText(/Syncing from/)).toBeTruthy()
    expect(screen.getByText(/Check the previous account before choosing Retry delivery/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Retry delivery" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Skip delivery" })).toBeTruthy()
    expect(api.retry).not.toHaveBeenCalled()
    api.retry.mockResolvedValue({ providers: dinero(clean), canDisconnect: true })
    fireEvent.click(screen.getByRole("button", { name: "Retry delivery" }))
    const dialog = within(await screen.findByRole("alertdialog"))
    expect(dialog.getByText(/Dinero account 1234/)).toBeTruthy()
    expect(api.retry).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }))
    expect(api.retry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Retry delivery" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retry delivery" }))
    await waitFor(() => expect(api.retry).toHaveBeenCalledWith({ deliveryId: "delivery-1", confirmReconnect: true }))
  })
  it.each(["source_review_required", "payload_totals_mismatch", "provider_totals_mismatch"])("offers only Skip for %s", async lastErrorCode => {
    load(dinero({ ...failed, lastErrorCode }, "error"))
    render(<AccountingIntegrationsCard />)
    expect(await screen.findByRole("button", { name: "Skip delivery" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Retry delivery" })).toBeNull()
  })
  it("reloads a stale mapping save with the current revision and shows backlog and invalid rows", async () => {
    const { defaultMappings } = await import("../../../domain/accounting/mappings")
    const providers = dinero(clean)
    Object.assign(providers[1]!, { generation: "g", mappingRevision: "old", mappings: defaultMappings(), mappingsInvalid: true, invalidMappingRows: [0] })
    load(providers)
    api.saveMappings.mockRejectedValueOnce(new Error("accounting_mapping_stale"))
    render(<AccountingIntegrationsCard />)
    expect(await screen.findByText("Pending deliveries: 3")).toBeTruthy()
    expect(screen.getByText("Waiting to retry: 2")).toBeTruthy()
    expect(screen.getByText("Review saved VAT group 1.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save mappings" }))
    const reload = await screen.findByRole("button", { name: "Reload settings" })
    const current = { ...providers[1], mappingRevision: "current", mappings: { ...defaultMappings(), paymentAccount: 55000 } }
    load([providers[0]!, current])
    api.saveMappings.mockResolvedValue({ providers: [providers[0], current], canDisconnect: true })
    fireEvent.click(reload)
    await waitFor(() => expect((screen.getByLabelText("Payment account") as HTMLInputElement).value).toBe("55000"))
    fireEvent.click(screen.getByRole("button", { name: "Save mappings" }))
    await waitFor(() => expect(api.saveMappings).toHaveBeenLastCalledWith(expect.objectContaining({ mappingRevision: "current" })))
  })
  it("retries the earliest failure and refreshes the card", async () => {
    load(dinero(failed, "error"))
    api.retry.mockResolvedValue({ providers: dinero(clean), canDisconnect: true })
    render(<AccountingIntegrationsCard />)
    fireEvent.click(await screen.findByRole("button", { name: "Retry delivery" }))
    await waitFor(() => expect(api.retry).toHaveBeenCalledWith({ deliveryId: "delivery-1" }))
    expect(await screen.findByText("Connected")).toBeTruthy()
  })
  it("requires a reason to skip and preserves the failure when the action fails", async () => {
    load(dinero(failed, "error"))
    api.skip.mockRejectedValue(new Error("unavailable"))
    render(<AccountingIntegrationsCard />)
    fireEvent.click(await screen.findByRole("button", { name: "Skip delivery" }))
    const dialog = within(await screen.findByRole("alertdialog")), confirm = dialog.getByRole("button", { name: "Skip delivery" }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(dialog.getByLabelText("Reason for skipping"), { target: { value: "Already entered" } })
    fireEvent.click(confirm)
    await waitFor(() => expect(api.skip).toHaveBeenCalledWith({ deliveryId: "delivery-1", reason: "Already entered" }))
    expect((await screen.findByRole("alert")).textContent).toBe("Could not update the delivery. Try again.")
    expect(screen.getByText("Failed deliveries: 1")).toBeTruthy()
  })
  it("hides failed delivery actions for non-admins", async () => {
    load(dinero(failed, "error"), false)
    render(<AccountingIntegrationsCard />)
    await screen.findByText("Failed deliveries: 1")
    expect(screen.queryByRole("button", { name: "Retry delivery" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Skip delivery" })).toBeNull()
  })
  it("shows both providers as not connected with a disabled coming-soon connect button", async () => {
    load(idle)
    render(<AccountingIntegrationsCard />)

    expect(await screen.findByText("e-conomic")).toBeTruthy()
    expect(screen.getByText("Dinero")).toBeTruthy()
    expect(screen.getAllByText("Not connected")).toHaveLength(2)
    expect(screen.getAllByText("Coming soon")).toHaveLength(2)
    for (const button of screen.getAllByRole("button", { name: "Connect" }) as HTMLButtonElement[]) expect(button.disabled).toBe(true)
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull()
  })

  it("shows failed deliveries and the last error in plain language", async () => {
    load(dinero({ lastDeliveredAt: new Date("2026-10-14T09:30:00Z"), failedCount: 2, lastErrorCode: "missing_mapping", blockedDocument: "INV-1" }, "error"))
    render(<AccountingIntegrationsCard />)

    const row = (await screen.findByText("Error")).closest("[data-provider]") as HTMLElement
    expect(within(row).getByText("Account 1234")).toBeTruthy()
    expect(within(row).getByText(/Last delivered/)).toBeTruthy()
    expect(within(row).getByText("Failed deliveries: 2")).toBeTruthy()
    expect(within(row).getByText("Missing mapping for INV-1.")).toBeTruthy()
    expect(within(row).getByText(/An account or VAT code is not mapped/)).toBeTruthy()
    expect(within(row).queryByText(/missing_mapping/)).toBeNull()
  })

  it("disconnects only after confirmation and then shows the provider as not connected", async () => {
    load(dinero(clean))
    api.disconnect.mockResolvedValue({ canDisconnect: true, providers: idle })
    render(<AccountingIntegrationsCard />)

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }))
    expect(api.disconnect).not.toHaveBeenCalled()
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }))
    await waitFor(() => expect(screen.getAllByText("Not connected")).toHaveLength(2))
    expect(api.disconnect).toHaveBeenCalledTimes(1)
  })

  it("keeps the connection on screen when disconnecting fails", async () => {
    load(dinero(clean))
    api.disconnect.mockRejectedValue(new Error("down"))
    render(<AccountingIntegrationsCard />)

    await confirmDisconnect()
    expect((await screen.findByRole("alert")).textContent).toBe("Could not disconnect. Try again.")
    expect(screen.getByText("Connected")).toBeTruthy()
  })

  it("hides disconnect from people who cannot change settings", async () => {
    load(dinero(clean), false)
    render(<AccountingIntegrationsCard />)

    expect(await screen.findByText("Nothing delivered yet")).toBeTruthy()
    expect(screen.queryByText(/Last error/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull()
  })

  it("shows a load error instead of an empty list", async () => {
    api.status.mockRejectedValue(new Error("down"))
    render(<AccountingIntegrationsCard />)

    expect((await screen.findByRole("alert")).textContent).toBe("Could not load accounting integrations.")
    expect(screen.queryByText("Loading accounting integrations…")).toBeNull()
    load(idle)
    fireEvent.click(screen.getByRole("button", { name: "Reload settings" }))
    expect(await screen.findByText("Dinero")).toBeTruthy()
  })
})

describe("describeAccountingError", () => {
  const t = (key: string, params?: Record<string, string | number>) => `${key}${params?.status ?? ""}`
  it.each([
    ["missing_mapping", "missing_mapping"], ["not_postable", "unsupported"], ["equation_violation", "unsupported"],
    ["http_403", "unauthorized"], ["http_422", "http422"], ["something_new", "unknown"], [null, "unknown"],
    ["payload_totals_mismatch", "payload_totals_mismatch"], ["provider_totals_mismatch", "provider_totals_mismatch"], ["source_review_required", "source_review_required"],
  ])("maps %s", (code, key) => {
    expect(describeAccountingError(code, "Dinero", t as never)).toBe(`accounting.deliveryError.${key}`)
  })
})
