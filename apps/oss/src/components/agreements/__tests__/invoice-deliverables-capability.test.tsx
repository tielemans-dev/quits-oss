// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const create = vi.hoisted(() => vi.fn())
vi.mock("../../../trpc/client", () => ({ trpc: { invoices: { createFromDeliverables: { mutate: create } } } }))
vi.mock("../../../lib/i18n/react", () => ({ useI18n: () => ({ locale: "en-US", t: (key: string) => key }) }))
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }))
import { InvoiceDeliverables } from "../invoice-deliverables"

const agreement = {
  id: "agreement", status: "accepted", billingTrigger: "on_acceptance", currency: "USD",
  deliverables: [
    { id: "service", title: "Design", status: "accepted", billingStatus: "unbilled", isDeposit: false, lineGross: 100, allocation: { state: "unbilled" } },
    { id: "deposit", title: "Advance payment", status: "planned", billingStatus: "unbilled", isDeposit: true, lineGross: 20, allocation: { state: "unbilled" } },
  ],
} as unknown as Parameters<typeof InvoiceDeliverables>[0]["agreement"]
afterEach(() => { cleanup(); vi.resetAllMocks() })

describe("invoice selection with deposits disabled", () => {
  it("still bills services without exposing or submitting a deposit or sale conversion", async () => {
    create.mockResolvedValue({})
    render(<InvoiceDeliverables agreement={agreement} depositsEnabled={false} onChanged={async () => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "agreements.invoice" }))
    expect(screen.queryByText(/Advance payment/)).toBeNull()
    expect(screen.queryByText("agreements.scheduleAsSaleChoice")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "agreements.createInvoices" }))
    await waitFor(() => expect(create).toHaveBeenCalledWith({ agreementId: "agreement", deliverableIds: ["service"], scheduleAsSale: false }))
  })
  it("preserves self-host deposit selection and the explicit sale choice", () => {
    render(<InvoiceDeliverables agreement={agreement} depositsEnabled={true} onChanged={async () => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "agreements.invoice" }))
    expect(screen.getByText(/Advance payment/)).toBeTruthy()
    expect(screen.getByText("agreements.scheduleAsSaleChoice")).toBeTruthy()
  })
})
