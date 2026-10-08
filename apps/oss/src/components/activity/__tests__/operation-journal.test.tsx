// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react"
import { enMessages } from "../../../lib/i18n/messages"
import { translate } from "../../../lib/i18n/translate"
import type { documentJournal } from "../../../domain/delivery/journal"

const api = vi.hoisted(() => ({
  query: vi.fn(),
  recover: vi.fn(),
  reconcile: vi.fn(),
  manualResend: vi.fn()
}))
vi.mock("../../../trpc/client", () => ({
  trpc: {
    journal: {
      forDocument: { query: api.query },
      recover: { mutate: api.recover },
      reconcile: { mutate: api.reconcile },
      manualResend: { mutate: api.manualResend }
    }
  }
}))
vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({
    locale: "en-US",
    t: (key: keyof typeof enMessages, vars?: Record<string, string | number>) =>
      translate(key, "en", vars)
  })
}))
import { OperationJournal } from "../operation-journal"

type Journal = Awaited<ReturnType<typeof documentJournal>>
function fixture(
  state: "uncertain" | "waiting_prerequisite" | "failed_step" = "uncertain"
): Journal {
  return {
    document: { id: "invoice-1", number: null, type: "invoice" },
    truncated: false,
    commands: [
      {
        id: "command-1",
        type: "invoice.create_draft",
        blocker: null,
        awaitingApproval: false,
        at: "2026-10-08T12:00:00Z",
        state: "effects_completed",
        steps: [{ type: "invoice.draft_created", at: "2026-10-08T12:00:00Z" }]
      }
    ],
    effects: [],
    deliveries: [
      {
        id: "delivery-1",
        commandId: "command-1",
        queuedAt: "2026-10-08T12:01:00Z",
        recipient: "recipient@example.test",
        state,
        provider: "smtp",
        providerReference: null,
        attempts: [{ startedAt: "2026-10-08T12:02:00Z", outcome: "uncertain" }],
        legacyAttempts: 0,
        evidence: [],
        recoveryOf: null,
        manualReason: null,
        settlementPending: false,
        canRecover: state === "waiting_prerequisite",
        canReconcile: false,
        canManualResend: state === "uncertain",
        failure: null
      }
    ]
  }
}
beforeEach(() => {
  api.query.mockResolvedValue(fixture())
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe("operation journal recovery decisions", () => {
  it("shows completed creation, the exact draft record, recipient and duplicate risk separately", async () => {
    render(<OperationJournal documentType="invoice" documentId="invoice-1" />)
    expect(await screen.findByText("Document creation completed")).toBeTruthy()
    expect(
      screen
        .getByRole("link", { name: "Record: invoice-1" })
        .getAttribute("href")
    ).toBe("/invoices/invoice-1")
    expect(screen.getByText("Email to recipient@example.test")).toBeTruthy()
    expect(screen.getByText("External outcome uncertain")).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: "Recover this delivery step" })
    ).toBeNull()
    expect(
      screen.getByText(/customer may already have this email/i)
    ).toBeTruthy()
  })
  it("requires both a reason and acknowledgement before queuing a manual resend", async () => {
    api.manualResend.mockResolvedValue(fixture())
    render(<OperationJournal documentType="invoice" documentId="invoice-1" />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Review manual resend" })
    )
    const submit = screen.getByRole("button", {
      name: "Record decision and resend"
    }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(
      screen.getByLabelText("Verification and reason for resending"),
      { target: { value: "Recipient requested a second copy after checking" } }
    )
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole("checkbox"))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(api.manualResend).toHaveBeenCalledTimes(1))
    expect(api.manualResend.mock.calls[0]?.[0]).toMatchObject({
      documentId: "invoice-1",
      deliveryId: "delivery-1",
      reason: "Recipient requested a second copy after checking",
      acknowledgeDuplicateRisk: true,
      clientRequestId: expect.any(String)
    })
  })
  it("distinguishes a prerequisite from failed delivery and retains completed effects", async () => {
    api.query.mockResolvedValue(fixture("waiting_prerequisite"))
    render(<OperationJournal documentType="invoice" documentId="invoice-1" />)
    expect(await screen.findByText("Waiting for a prerequisite")).toBeTruthy()
    expect(screen.getByText("Document creation completed")).toBeTruthy()
    expect(screen.queryByText("Step failed")).toBeNull()
    expect(
      screen.getByRole("button", { name: "Recover this delivery step" })
    ).toBeTruthy()
  })
  it("does not call a manual resend on cancel and displays failed recovery without replacing its history", async () => {
    api.manualResend.mockRejectedValue(
      new Error("Delivery changed. Refresh and try again.")
    )
    render(<OperationJournal documentType="invoice" documentId="invoice-1" />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Review manual resend" })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel resend decision" })
    )
    expect(api.manualResend).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", { name: "Review manual resend" })
    )
    fireEvent.change(
      screen.getByLabelText("Verification and reason for resending"),
      { target: { value: "Requested" } }
    )
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(
      screen.getByRole("button", { name: "Record decision and resend" })
    )
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Delivery changed. Refresh and try again."
    )
    expect(screen.getByText("External outcome uncertain")).toBeTruthy()
  })
})
