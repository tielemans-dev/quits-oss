// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import type { ComponentType, ReactNode } from "react"
import { afterEach, expect, it, vi } from "vitest"
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options, useParams: () => ({ scheduleId: "missing" }) }),
  Link: ({ children }: { children: ReactNode }) => <a href="/recurring">{children}</a>,
}))
vi.mock("../../trpc/client", () => ({ trpc: { recurring: {
  get: { query: async () => { throw Object.assign(new Error("Missing"), { data: { code: "NOT_FOUND" } }) } },
  capabilities: { query: async () => ({ canUpdate: true }) },
} } }))
vi.mock("../../lib/auth-client", () => ({ authClient: {}, useSession: () => ({ data: null }) }))
vi.mock("../../lib/i18n/react", () => ({ useI18n: () => ({ locale: "en-US", t: (key: string) => key }) }))
import { Route } from "../_app/recurring/$scheduleId"
const Page = (Route as unknown as { component: ComponentType }).component
afterEach(cleanup)
it("offers the recurring-list exit for a confirmed missing schedule", async () => {
  render(<Page />)
  await screen.findByText("recurring.detail.notFound")
  expect(screen.getByRole("link", { name: "recurring.action.back" }).getAttribute("href")).toBe("/recurring")
  expect(screen.queryByRole("button", { name: "ui.retry" })).toBeNull()
})
