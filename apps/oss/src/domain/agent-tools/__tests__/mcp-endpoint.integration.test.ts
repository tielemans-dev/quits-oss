import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../lib/email", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/email")>("../../../lib/email")
  return { ...actual, sendInvoiceEmail: vi.fn().mockResolvedValue({ id: "email_123" }) }
})

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../../trpc/router"
import { createAgentKey, revokeAgentKey } from "../../agent-keys"
import type { AgentActor } from "../../actor"
import { handleMcpRequest } from "../mcp"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip
const MCP_URL = "http://yaip.test/api/mcp"

type Org = Awaited<ReturnType<typeof createTestOrganization>>

function rawPost(body: unknown, headers: Record<string, string> = {}) {
  return handleMcpRequest(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  )
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
}

async function connect(secret: string) {
  const client = new Client({ name: "yaip-test", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    fetch: (input, init) => handleMcpRequest(new Request(input, init)),
  })
  await client.connect(transport)
  return client
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = (result as CallToolResult).content[0]
  if (content?.type !== "text") throw new Error("expected text content")
  const isError = Boolean(result.isError)
  try {
    return { isError, value: JSON.parse(content.text) }
  } catch {
    // Protocol-level failures (unknown tool, schema mismatch) come back as plain text.
    return { isError, value: content.text as unknown }
  }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return parse(await client.callTool({ name, arguments: args }))
}

function callerFor(org: Org, role: "admin" | "member" | "accountant") {
  const userId = org.actors[role].userId
  return appRouter.createCaller({
    session: {
      user: { id: userId, email: `${userId}@test.yaip.invalid`, name: userId },
      session: { activeOrganizationId: org.organizationId },
    },
  } as never)
}

describeIfDatabase("MCP endpoint", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function setup(roles: Array<"admin" | "member" | "accountant"> = ["admin"]) {
    const org = await createTestOrganization({ roles })
    cleanups.push(async () => {
      await prisma.agentKey.deleteMany({ where: { organizationId: org.organizationId } })
      await org.cleanup()
    })
    return org
  }

  async function keyFor(org: Org, mode: AgentActor["mode"], scopes: string[], name = "Bookkeeper") {
    return createAgentKey(org.actors.admin, { name, mode, scopes })
  }

  const drafting = [
    "settings:read",
    "contact:read",
    "contact:create",
    "invoice:read",
    "invoice:create",
    "invoice:update",
    "invoice:send",
  ]

  describe("authentication", () => {
    it("rejects requests without a bearer key", async () => {
      const response = await rawPost(initialize)
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toContain("Bearer")
      expect((await response.json()).error.message).toContain("Missing agent key")
    })

    it("rejects unknown and revoked keys", async () => {
      const org = await setup()
      const { key, secret } = await keyFor(org, "full_access", ["contact:read"])

      const unknown = await rawPost(initialize, { authorization: "Bearer yaip_ak_unknown" })
      expect(unknown.status).toBe(401)
      expect((await unknown.json()).error.message).toBe("Invalid agent key")

      const valid = await rawPost(initialize, { authorization: `Bearer ${secret}` })
      expect(valid.status).toBe(200)

      await revokeAgentKey(org.actors.admin, key.id)
      const revoked = await rawPost(initialize, { authorization: `Bearer ${secret}` })
      expect(revoked.status).toBe(401)
      expect((await revoked.json()).error.message).toContain("revoked")
    })

    it("answers GET with 405 because the server is stateless", async () => {
      const response = await handleMcpRequest(new Request(MCP_URL, { method: "GET" }))
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("POST")
    })
  })

  describe("tool listing", () => {
    it("lists only tools within the key's scopes and hides commands from read-only keys", async () => {
      const org = await setup()
      const readOnly = await keyFor(org, "read_only", ["settings:read", "contact:read", "contact:create"])
      const client = await connect(readOnly.secret)
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name).sort()).toEqual(["contact_get", "contacts_list", "organization_read"])

      const writer = await connect((await keyFor(org, "approval_required", drafting)).secret)
      const names = (await writer.listTools()).tools.map((tool) => tool.name)
      expect(names).toEqual(
        expect.arrayContaining(["contact_create", "invoice_send", "command_status", "command_wait"])
      )
      expect(names).not.toContain("activity_read")
      expect(names).not.toContain("quotes_list")

      const send = (await writer.listTools()).tools.find((tool) => tool.name === "invoice_send")
      expect(send?.inputSchema.required).toEqual(expect.arrayContaining(["id", "clientRequestId"]))
      expect(send?.description).toContain("approval")
    })

    it("refuses command tools for read-only keys even when called directly", async () => {
      const org = await setup()
      const { secret } = await keyFor(org, "read_only", ["contact:read", "contact:create"])
      const client = await connect(secret)
      const result = await call(client, "contact_create", { name: "Nope", clientRequestId: "c-1" })
      expect(result).toMatchObject({ isError: true, value: expect.stringContaining("not found") })
      expect(await prisma.contact.count({ where: { organizationId: org.organizationId } })).toBe(0)
    })

    it("reports the organization and the key's own mode", async () => {
      const org = await setup()
      const client = await connect((await keyFor(org, "approval_required", drafting)).secret)
      const { value } = await call(client, "organization_read")
      expect(value.organization).toMatchObject({ currency: "USD", taxRegime: "us_sales_tax" })
      expect(value.agent).toMatchObject({ mode: "approval_required", name: "Agent: Bookkeeper" })
    })
  })

  describe("commands", () => {
    it("creates a contact once per clientRequestId", async () => {
      const org = await setup()
      const client = await connect((await keyFor(org, "approval_required", drafting)).secret)

      const args = { name: "Acme", email: "billing@acme.test", clientRequestId: "contact-acme-1" }
      const first = await call(client, "contact_create", args)
      const retry = await call(client, "contact_create", args)

      expect(first.value).toMatchObject({ status: "completed", commandType: "contact.create" })
      expect(retry.value).toEqual(first.value)
      expect(await prisma.contact.count({ where: { organizationId: org.organizationId } })).toBe(1)

      const listed = await call(client, "contacts_list", { search: "acme" })
      expect(listed.value).toHaveLength(1)
    })

    it("returns domain errors without internals", async () => {
      const org = await setup()
      const client = await connect((await keyFor(org, "full_access", drafting)).secret)
      const missing = await call(client, "invoice_get", { id: "does-not-exist" })
      expect(missing).toEqual({
        isError: true,
        value: { error: { tag: "NotFound", message: "Invoice not found" } },
      })
    })

    it("queues invoice_send for approval and reports completion after a person approves", async () => {
      const org = await setup()
      const client = await connect((await keyFor(org, "approval_required", drafting)).secret)

      const contact = await call(client, "contact_create", {
        name: "Acme",
        email: "billing@acme.test",
        clientRequestId: "contact-1",
      })
      const draft = await call(client, "invoice_create_draft", {
        contactId: contact.value.result.id,
        dueDate: "2026-12-01",
        taxRate: 25,
        items: [{ description: "Design", quantity: 2, unitPrice: 100 }],
        clientRequestId: "draft-1",
      })
      expect(draft.value).toMatchObject({
        status: "completed",
        result: { status: "draft", totalGross: 250, balanceDue: 250 },
      })
      const invoiceId = draft.value.result.id

      const queued = await call(client, "invoice_send", {
        id: invoiceId,
        allowSendWithoutEmail: true,
        clientRequestId: "send-1",
      })
      expect(queued.value).toMatchObject({ status: "awaiting_approval", result: null })
      const { commandId, approvalRequestId } = queued.value

      const waiting = await call(client, "command_wait", { commandId, timeoutMs: 50 })
      expect(waiting.value).toMatchObject({ timedOut: true, command: { status: "awaiting_approval" } })

      const admin = callerFor(org, "admin")
      expect(await admin.agents.pendingCount()).toBe(1)
      const [pending] = await admin.agents.approvals({ view: "pending" })
      expect(pending).toMatchObject({
        id: approvalRequestId,
        commandType: "invoice.send",
        canDecide: true,
        agent: { name: "Bookkeeper" },
      })

      const decided = await admin.agents.decide({ approvalRequestId, decision: "approve", note: "ok" })
      expect(decided).toMatchObject({ status: "completed", commandId })

      const done = await call(client, "command_wait", { commandId, timeoutMs: 1000 })
      expect(done.value).toMatchObject({
        timedOut: false,
        command: { status: "completed", result: { id: invoiceId, status: "sent" } },
      })
      const status = await call(client, "command_status", { commandId })
      expect(status.value).toEqual(done.value.command)

      const retried = await call(client, "invoice_send", {
        id: invoiceId,
        allowSendWithoutEmail: true,
        clientRequestId: "send-1",
      })
      expect(retried.value).toMatchObject({ status: "completed", commandId })

      const [history] = await admin.agents.approvals({ view: "history" })
      expect(history).toMatchObject({ status: "approved", commandStatus: "completed", decisionNote: "ok" })
      expect(await admin.agents.pendingCount()).toBe(0)
    })

    it("does not let an agent read another agent's commands", async () => {
      const org = await setup()
      const first = await connect((await keyFor(org, "full_access", drafting, "First")).secret)
      const second = await connect((await keyFor(org, "full_access", drafting, "Second")).secret)

      const created = await call(first, "contact_create", { name: "Acme", clientRequestId: "c-1" })
      const own = await call(first, "command_status", { commandId: created.value.commandId })
      expect(own.value.status).toBe("completed")

      const other = await call(second, "command_status", { commandId: created.value.commandId })
      expect(other).toMatchObject({ isError: true, value: { error: { tag: "NotFound" } } })
    })
  })
})
