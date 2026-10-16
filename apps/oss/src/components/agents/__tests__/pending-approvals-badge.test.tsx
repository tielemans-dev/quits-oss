// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
const count = vi.hoisted(() => vi.fn())
vi.mock("../../../trpc/client", () => ({ trpc: { agents: { pendingCount: { query: count } } } }))
vi.mock("../../../lib/auth-client", () => ({ authClient: {}, useSession: () => ({ data: null }) }))
import { notifyMutation } from "../../../lib/query-refresh"
import { PendingApprovalsBadge } from "../pending-approvals-badge"
afterEach(() => { cleanup(); vi.resetAllMocks() })
it("retains the last known count on a failed refresh and updates after recovery", async () => {
  count.mockResolvedValueOnce(3).mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue(0)
  render(<PendingApprovalsBadge />)
  await screen.findByText("3")
  await act(async () => notifyMutation("agents.decide", null))
  expect(screen.getByText("3")).toBeTruthy()
  await act(async () => notifyMutation("agents.decide", null))
  expect(screen.queryByText("3")).toBeNull()
})
