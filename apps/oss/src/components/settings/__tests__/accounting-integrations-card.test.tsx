// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

const api = vi.hoisted(() => ({ status: vi.fn(), disconnect: vi.fn() }))

vi.mock("../../../trpc/client", () => ({
  trpc: { accounting: { status: { query: api.status }, disconnect: { mutate: api.disconnect } } },
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
const clean = { lastDeliveredAt: null, failedCount: 0, lastErrorCode: null }
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
    load(dinero({ lastDeliveredAt: new Date("2026-10-14T09:30:00Z"), failedCount: 2, lastErrorCode: "missing_mapping" }, "error"))
    render(<AccountingIntegrationsCard />)

    const row = (await screen.findByText("Error")).closest("[data-provider]") as HTMLElement
    expect(within(row).getByText("Account 1234")).toBeTruthy()
    expect(within(row).getByText(/Last delivered/)).toBeTruthy()
    expect(within(row).getByText("Failed deliveries: 2")).toBeTruthy()
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
  })
})

describe("describeAccountingError", () => {
  const t = (key: string, params?: Record<string, string | number>) => `${key}${params?.status ?? ""}`
  it.each([
    ["missing_mapping", "missing_mapping"], ["not_postable", "unsupported"], ["equation_violation", "unsupported"],
    ["http_403", "unauthorized"], ["http_422", "http422"], ["something_new", "unknown"], [null, "unknown"],
  ])("maps %s", (code, key) => {
    expect(describeAccountingError(code, "Dinero", t as never)).toBe(`accounting.deliveryError.${key}`)
  })
})
