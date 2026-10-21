// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

const api = vi.hoisted(() => ({ status: vi.fn(), download: vi.fn() }))

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children }))

vi.mock("../../../../trpc/client", () => ({
  trpc: { exports: { einvoiceStatus: { query: api.status }, einvoice: { query: api.download } } },
}))

vi.mock("../../../../lib/i18n/react", () => ({
  useI18n: () => ({ locale: "en-US", t: translate }),
}))

function translate(key: string) {
  return key
}

import { InvoiceExportsPanel } from "../exports-panel"
import type { InvoicePanelInvoice } from "../types"

const invoice: InvoicePanelInvoice = {
  id: "inv_1",
  number: "2026-0005",
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

function renderPanel(status = "sent") {
  return render(<InvoiceExportsPanel invoice={{ ...invoice, status }} onChanged={async () => {}} />)
}

describe("InvoiceExportsPanel", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("explains what an issued invoice lacked without a click", async () => {
    api.status.mockResolvedValue({ stored: false, missing: ["buyer.electronicAddress"] })
    renderPanel()
    expect(await screen.findByText("exports.einvoice.missing.issuedTitle")).toBeTruthy()
    expect(screen.getByText("exports.einvoice.missing.buyer.electronicAddress")).toBeTruthy()
    expect(screen.queryByText("exports.einvoice.download")).toBeNull()
    expect(api.status).toHaveBeenCalledWith({ kind: "invoice", id: "inv_1" })
    expect(api.download).not.toHaveBeenCalled()
  })

  it("says an issued invoice has no e-invoice when no gap explains it", async () => {
    api.status.mockResolvedValue({ stored: false, missing: [] })
    renderPanel()
    expect(await screen.findByText("exports.einvoice.unavailable")).toBeTruthy()
    expect(screen.queryByText("exports.einvoice.download")).toBeNull()
    expect(api.download).not.toHaveBeenCalled()
  })

  it("offers the download when the e-invoice is stored", async () => {
    api.status.mockResolvedValue({ stored: true })
    renderPanel()
    await waitFor(() => expect(api.status).toHaveBeenCalled())
    expect(screen.getByText("exports.einvoice.download")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("asks nothing for a draft", () => {
    renderPanel("draft")
    expect(api.status).not.toHaveBeenCalled()
  })
})
