// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react"

const { authorizeRebill } = vi.hoisted(() => ({ authorizeRebill: vi.fn().mockResolvedValue({}) }))
vi.mock("../../../trpc/client", () => ({ trpc: { agreements: { authorizeRebill: { mutate: authorizeRebill } } } }))
vi.mock("../../../lib/i18n/react", () => ({ useI18n: () => ({ t: (key: string, values?: Record<string, string | number>) => `${key} ${values ? Object.values(values).join(" ") : ""}`.trim() }) }))
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
import { DeliverableAllocation } from "../deliverable-allocation"

afterEach(() => { cleanup(); vi.clearAllMocks() })
type Props = Parameters<typeof DeliverableAllocation>[0]

it("shows every credit in the confirmation and submits the set actually reviewed even after refresh", async () => {
  const notes = [{ id: "cn-40", number: "CN-0040" }, { id: "cn-60", number: "CN-0060" }]
  const props = (creditNotes = notes) => ({
    agreement: { id: "agreement-1" },
    line: { id: "line-1", title: "Design", allocation: { state: "credited", generation: 0, holder: null, creditNotes, creditedQuantity: "1", quantity: "1", invoiceHasUntiedCredit: false, rebill: { eligible: true, blocker: null }, rebills: [] } },
    capabilities: { authorizeRebill: true }, onChanged: vi.fn(), onError: vi.fn(),
  }) as unknown as Props
  const view = render(<DeliverableAllocation {...props()} />)
  fireEvent.click(screen.getByRole("button", { name: "agreements.allocation.allowRebill" }))
  const dialog = within(screen.getByRole("alertdialog"))
  expect(dialog.getByText(/agreements.allocation.rebillConfirm/).textContent).toContain("CN-0040, CN-0060")
  view.rerender(<DeliverableAllocation {...props([{ id: "cn-new", number: "CN-NEW" }])} />)
  expect(dialog.getByText(/agreements.allocation.rebillConfirm/).textContent).toContain("CN-0040, CN-0060")
  fireEvent.change(dialog.getByRole("textbox"), { target: { value: "Both corrections reviewed" } })
  fireEvent.click(dialog.getByRole("button", { name: "agreements.allocation.allowRebill" }))
  await waitFor(() => expect(authorizeRebill).toHaveBeenCalledWith({ agreementId: "agreement-1", deliverableId: "line-1", creditNoteId: "cn-40", creditNoteIds: ["cn-40", "cn-60"], reason: "Both corrections reviewed" }))
})
