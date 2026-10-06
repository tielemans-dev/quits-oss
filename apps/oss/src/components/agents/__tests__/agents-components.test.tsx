import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("../../../lib/i18n/react", () => ({
  useI18n: () => ({
    locale: "en-US",
    t: (key: string, values?: Record<string, string | number>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}))

import { AgentKeySecret } from "../agent-key-secret"
import { ApprovalItem } from "../approval-item"
import type { ApprovalRow } from "../types"

const approval: ApprovalRow = {
  id: "apr_1",
  commandId: "cmd_1",
  commandType: "invoice.send",
  command: { id: "inv_1" },
  summary: "Send invoice inv_1 to the customer",
  status: "pending",
  agent: { id: "key_1", name: "Bookkeeper", displayPrefix: "yaip_ak_abc123", revokedAt: null },
  createdAt: new Date("2026-10-06T10:00:00Z"),
  expiresAt: new Date("2026-10-13T10:00:00Z"),
  decidedAt: null,
  decidedByName: null,
  decisionNote: null,
  commandStatus: "awaiting_approval",
  commandError: null,
  requiredPermission: "invoice:send",
  canDecide: true,
}

describe("agent components", () => {
  it("shows the secret with Claude Code and JSON client configuration", () => {
    const html = renderToStaticMarkup(<AgentKeySecret secret="yaip_ak_secret" />)
    expect(html).toContain("yaip_ak_secret")
    expect(html).toContain("claude mcp add --transport http yaip /api/mcp")
    expect(html).toContain("Authorization: Bearer yaip_ak_secret")
    expect(html).toContain("&quot;mcpServers&quot;")
  })

  it("offers approve and reject only to people who may decide", () => {
    const html = renderToStaticMarkup(<ApprovalItem approval={approval} />)
    expect(html).toContain("Send invoice inv_1 to the customer")
    expect(html).toContain("agents.approvals.approve")
    expect(html).toContain("agents.approvals.reject")

    const readOnly = renderToStaticMarkup(<ApprovalItem approval={{ ...approval, canDecide: false }} />)
    expect(readOnly).not.toContain("agents.approvals.approve")
    expect(readOnly).toContain("agents.approvals.noPermission")
  })

  it("shows the decision and command outcome in history", () => {
    const html = renderToStaticMarkup(
      <ApprovalItem
        approval={{
          ...approval,
          status: "approved",
          decidedAt: new Date("2026-10-06T11:00:00Z"),
          decidedByName: "Ada",
          decisionNote: "Looks right",
          commandStatus: "failed",
          commandError: "Email delivery is not configured",
        }}
      />
    )
    expect(html).toContain("agents.approvals.status.approved")
    expect(html).toContain("Looks right")
    expect(html).toContain("Email delivery is not configured")
    expect(html).not.toContain("agents.approvals.approve")
  })
})
