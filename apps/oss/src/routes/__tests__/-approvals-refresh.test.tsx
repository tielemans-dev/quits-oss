// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ComponentType } from "react"
import { afterEach, expect, it, vi } from "vitest"
const api = vi.hoisted(() => ({ list: vi.fn(), decide: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: unknown) => options }))
vi.mock("../../trpc/client", () => ({ trpc: { agents: { approvals: { query: api.list }, decide: { mutate: api.decide } } } }))
vi.mock("../../lib/auth-client", () => ({ authClient: {}, useSession: () => ({ data: null }) }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ locale: "en-US", t: (key: string, params?: { message?: string }) => params?.message ?? key }) }))
import { notifyMutation } from "../../lib/query-refresh"
import { Route } from "../_app/approvals"
const Page = (Route as unknown as { component: ComponentType }).component

afterEach(() => { cleanup(); vi.resetAllMocks() })
it("keeps an approval execution failure visible when the pending query refreshes", async () => {
  api.list.mockResolvedValueOnce([{ id: "a1", summary: "Send invoice", status: "pending", agent: { name: "Helper", displayPrefix: "key" }, commandType: "invoice.send", createdAt: new Date(), expiresAt: new Date(), canDecide: true }]).mockResolvedValue([])
  api.decide.mockImplementation(async () => {
    notifyMutation("agents.decide", null)
    return { status: "failed", error: { message: "Execution refused" } }
  })
  render(<Page />)
  fireEvent.click(await screen.findByRole("button", { name: "agents.approvals.approve" }))
  await screen.findByText("Execution refused")
  await act(async () => {})
  expect(screen.getByText("Send invoice")).toBeTruthy()
  expect(screen.getByText("Execution refused")).toBeTruthy()
  expect(api.list).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole("tab", { name: "agents.approvals.tab.history" }))
  await screen.findByText("agents.approvals.empty.history")
  expect(screen.queryByText("Execution refused")).toBeNull()
})
