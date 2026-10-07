import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { CommandError } from "@quits/contracts/agent"
import { appLogger } from "../../lib/observability"
import type { AgentActor } from "../actor"
import { authenticateAgentSecret } from "../agent-keys"
import type { AgentTool } from "./define"
import { getAgentTool, visibleAgentTools } from "./registry"
import { resolveUrlOrigin, readProductEnv } from "@quits/shared/runtimeEnv"

const logger = appLogger.child("agent-api")

const SERVER_INSTRUCTIONS = [
  "Quits is an invoicing system. Call organization_read first to learn the currency, tax regime,",
  "and your key's mode and scopes.",
  "Reads are free. Drafts (contact_create, invoice_create_draft, invoice_update_draft) are free and",
  "never leave Quits. Commands that leave Quits or move money, such as invoice_send, may return",
  "status awaiting_approval; a person approves them in Quits, then call command_wait with the",
  "commandId instead of sending again.",
  "Every command takes a clientRequestId you choose; reuse it when retrying so nothing runs twice.",
].join(" ")

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}) {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message }, id: null },
    { status, headers }
  )
}

function readBearer(request: Request) {
  const header = request.headers.get("authorization") ?? ""
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match?.[1] ?? null
}

function isDomainError(error: unknown): error is { _tag: string; message: string } {
  return Boolean(error && typeof error === "object" && "_tag" in error && "message" in error)
}

/** Converts a thrown error into the error shape agents see. Never includes stack traces. */
export function toToolError(error: unknown): CommandError {
  if (isDomainError(error)) {
    const extra = error as { code?: unknown; issues?: unknown }
    return {
      tag: error._tag,
      message: error.message,
      ...(typeof extra.code === "string" ? { code: extra.code } : {}),
      ...(Array.isArray(extra.issues) ? { issues: extra.issues as CommandError["issues"] } : {}),
    }
  }
  return { tag: "InternalError", message: "The tool failed unexpectedly. Try again later." }
}

export type ToolRunResult = { ok: true; value: unknown } | { ok: false; error: CommandError }

/** Validates input and runs one tool as the agent. Shared by MCP and tests. */
export async function runAgentTool(
  actor: AgentActor,
  name: string,
  rawInput: unknown,
  options: { signal?: AbortSignal } = {}
): Promise<ToolRunResult> {
  let tool: AgentTool
  try {
    tool = getAgentTool(actor, name)
  } catch (error) {
    return { ok: false, error: toToolError(error) }
  }

  const parsed = tool.input.safeParse(rawInput ?? {})
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        tag: "ValidationFailed",
        message: "Invalid tool input",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    }
  }

  try {
    return { ok: true, value: await tool.run({ actor, signal: options.signal }, parsed.data) }
  } catch (error) {
    if (!isDomainError(error)) {
      logger.error("agent_tool.crashed", {
        tool: name,
        organizationId: actor.organizationId,
        agentKeyId: actor.agentKeyId,
        error,
      })
    }
    return { ok: false, error: toToolError(error) }
  }
}

function toCallToolResult(result: ToolRunResult): CallToolResult {
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: result.error }) }],
    }
  }
  const value = result.value
  const structured =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(structured ? { structuredContent: structured } : {}),
  }
}

/** Builds an MCP server exposing only the tools this agent key may use. */
export function createAgentMcpServer(actor: AgentActor) {
  const server = new McpServer(
    { name: "quits", title: "Quits invoicing", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  )

  for (const tool of visibleAgentTools(actor)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.kind === "query",
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args: unknown, extra: { signal: AbortSignal }) =>
        toCallToolResult(await runAgentTool(actor, tool.name, args, { signal: extra.signal }))
    )
  }

  return server
}

/**
 * Serves one MCP request over Streamable HTTP in stateless mode: every POST authenticates the
 * bearer key and gets a fresh server, so any app instance can handle any request.
 */
/**
 * The MCP Streamable HTTP spec requires servers to validate `Origin` to stop DNS-rebinding
 * attacks from browsers. Non-browser clients send no Origin and are allowed; browser requests
 * must come from the app itself or an origin listed in `QUITS_MCP_ALLOWED_ORIGINS`.
 */
export function isAllowedMcpOrigin(origin: string | null, env: Record<string, string | undefined> = process.env) {
  if (!origin) {
    return true
  }

  const allowed = new Set(
    [
      resolveUrlOrigin(env.BETTER_AUTH_URL),
      resolveUrlOrigin(readProductEnv(env, "APP_ORIGIN")),
      ...(readProductEnv(env, "MCP_ALLOWED_ORIGINS") ?? "").split(",").map((value) => resolveUrlOrigin(value.trim())),
    ].filter((value): value is string => Boolean(value))
  )
  return allowed.has(resolveUrlOrigin(origin) ?? "")
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  if (!isAllowedMcpOrigin(request.headers.get("origin"))) {
    return jsonRpcError(403, "Origin not allowed")
  }

  if (request.method !== "POST") {
    // Stateless servers have no server-initiated stream to open or session to delete.
    return jsonRpcError(405, "Method not allowed. Send MCP requests with POST.", { Allow: "POST" })
  }

  const secret = readBearer(request)
  if (!secret) {
    return jsonRpcError(401, "Missing agent key. Send Authorization: Bearer quits_ak_...", {
      "WWW-Authenticate": 'Bearer realm="quits"',
    })
  }

  let actor: AgentActor
  try {
    actor = await authenticateAgentSecret(secret)
  } catch (error) {
    if (isDomainError(error) && error._tag === "Forbidden") {
      return jsonRpcError(401, error.message, {
        "WWW-Authenticate": 'Bearer realm="quits", error="invalid_token"',
      })
    }
    throw error
  }

  const server = createAgentMcpServer(actor)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    // JSON responses are complete once returned, so the per-request server can be released.
    void server.close()
  }
}
