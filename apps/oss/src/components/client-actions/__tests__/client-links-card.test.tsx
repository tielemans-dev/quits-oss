// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LocalizedDocument } from "../../documents/localized-document"
import { ClientLinksCard } from "../client-links-card"

const { list, candidates, create } = vi.hoisted(() => ({ list: vi.fn(), candidates: vi.fn(), create: vi.fn() }))
vi.mock("../../../trpc/client", () => ({ trpc: { clientLinks: {
  list: { query: list }, candidates: { query: candidates }, create: { mutate: create },
} } }))

beforeEach(() => {
  list.mockReset().mockResolvedValue([])
  candidates.mockReset()
  create.mockReset().mockResolvedValue({ url: "/c/synthetic-test-link" })
})
afterEach(cleanup)

describe("client link presets", () => {
  it("waits for the records before letting a preset select its grants", async () => {
    let complete!: (value: unknown) => void
    candidates.mockReturnValue(new Promise((resolve) => { complete = resolve }))
    render(<LocalizedDocument locale="en-US"><ClientLinksCard contactId="c1" contactName="Client" contactEmail="client@example.test" /></LocalizedDocument>)
    fireEvent.click(await screen.findByRole("button", { name: "Create client link" }))
    const finance = screen.getByRole("button", { name: "Finance contact" }) as HTMLButtonElement
    const approver = screen.getByRole("button", { name: "Project approver" }) as HTMLButtonElement
    expect(finance.disabled).toBe(true)
    expect(approver.disabled).toBe(true)
    fireEvent.click(finance)
    expect(create).not.toHaveBeenCalled()

    await act(async () => complete({
      agreements: [{ id: "a1", number: "AGR-1", title: "Offer" }], deliverables: [],
      invoices: [{ id: "i1", number: "INV-1" }],
    }))
    expect(finance.disabled).toBe(false)
    fireEvent.click(finance)
    expect((screen.getByRole("combobox", { name: "INV-1" }) as HTMLSelectElement).value).toBe("pay")
    expect((screen.getByRole("combobox", { name: "AGR-1 · Offer" }) as HTMLSelectElement).value).toBe("none")
    fireEvent.click(screen.getByRole("button", { name: "Create link" }))
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      contactId: "c1", recipientName: "Client", recipientEmail: "client@example.test",
      expiresInDays: 30, verification: "none",
      grants: [{ kind: "invoice", recordId: "i1", capabilities: ["view", "pay"] }],
    }))
  })
})
