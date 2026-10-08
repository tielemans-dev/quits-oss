import { z } from "zod"
import { nonEmptyStringSchema } from "./baseSchemas"

/**
 * How much an agent may do without a human, mirroring T3 Code runtime modes.
 * - read_only: queries only
 * - approval_required: drafts freely; outward-facing or money-moving commands wait for approval
 * - full_access: everything its scopes allow
 */
export const agentModeSchema = z.enum(["read_only", "approval_required", "full_access"])

export const commandStatusSchema = z.enum([
  "completed",
  "awaiting_approval",
  "rejected",
  "expired",
  "failed",
])

export const clientRequestIdSchema = nonEmptyStringSchema
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Use letters, digits, '.', '_', ':' or '-'")

export const commandErrorSchema = z.object({
  tag: z.string(),
  message: z.string(),
  code: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
})

export const commandRecordSchema = z.object({
  commandId: z.string(),
  commandType: z.string(),
  status: commandStatusSchema,
  result: z.unknown().nullable(),
  error: commandErrorSchema.nullable(),
  approvalRequestId: z.string().nullable(),
})

export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"])

export const agentKeyCreateInputSchema = z.object({
  name: nonEmptyStringSchema.max(80),
  mode: agentModeSchema.default("approval_required"),
  scopes: z.array(nonEmptyStringSchema).min(1),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
})

export type AgentMode = z.infer<typeof agentModeSchema>
export type CommandStatus = z.infer<typeof commandStatusSchema>
export type CommandError = z.infer<typeof commandErrorSchema>
export type CommandRecord = z.infer<typeof commandRecordSchema>
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>
export type AgentKeyCreateInput = z.input<typeof agentKeyCreateInputSchema>

export const agentKeyIdInputSchema = z.object({ id: nonEmptyStringSchema })

export const approvalDecisionSchema = z.enum(["approve", "reject"])

export const approvalDecideInputSchema = z.object({
  approvalRequestId: nonEmptyStringSchema,
  decision: approvalDecisionSchema,
  note: z.string().trim().max(1000).optional(),
})

export const approvalListInputSchema = z.object({
  view: z.enum(["pending", "history"]).default("pending"),
  limit: z.number().int().min(1).max(200).default(50),
})

/**
 * Starting points for a new key. Each preset is narrowed to the scopes the creating user holds,
 * so a member never sees scopes they cannot grant.
 */
export const agentScopePresetIdSchema = z.enum(["read_only_bookkeeper", "drafting_assistant", "full_access"])

const readScopes = [
  "settings:read",
  "contact:read",
  "invoice:read",
  "agreement:read",
  "deliverable:read",
  "quote:read",
  "creditNote:read",
  "payment:read",
  "recurring:read",
  "catalog:read",
  "export:read",
  "audit:read",
] as const

export const agentScopePresets = {
  read_only_bookkeeper: { mode: "read_only", scopes: readScopes },
  drafting_assistant: {
    mode: "approval_required",
    scopes: [
      ...readScopes,
      "contact:create",
      "contact:update",
      "invoice:create",
      "invoice:update",
      "invoice:send",
      "agreement:create",
      "agreement:update",
      "agreement:send",
      "deliverable:update",
      "deliverable:deliver",
      "quote:create",
      "quote:update",
      "quote:send",
      "creditNote:create",
      "payment:create",
      "recurring:create",
      "recurring:update",
    ],
  },
  /** Every scope the creator holds except managing agents. */
  full_access: { mode: "full_access", scopes: "all" },
} as const satisfies Record<
  z.infer<typeof agentScopePresetIdSchema>,
  { mode: AgentMode; scopes: readonly string[] | "all" }
>

// Agent tool inputs. Command tools reuse the feature input schemas and add `clientRequestId`.

const listLimitSchema = z.number().int().min(1).max(200).default(50)
const listCursorSchema = z
  .string()
  .trim()
  .max(500)
  .optional()
  .describe("nextCursor from the previous page; omit for the first page")

export const contactsListToolInputSchema = z.object({
  search: z.string().trim().max(120).optional().describe("Matches name, email, or company"),
  limit: listLimitSchema,
  cursor: listCursorSchema,
})

export const invoicesListToolInputSchema = z.object({
  status: z
    .enum(["draft", "sent", "viewed", "overdue", "paid", "credited"])
    .optional()
    .describe("Document status"),
  paymentStatus: z.enum(["unpaid", "partially_paid", "paid"]).optional(),
  contactId: z.string().trim().min(1).optional(),
  limit: listLimitSchema,
  cursor: listCursorSchema,
})

export const quotesListToolInputSchema = z.object({
  status: z.string().trim().max(40).optional().describe("Quote status, e.g. draft, sent, accepted"),
  contactId: z.string().trim().min(1).optional(),
  limit: listLimitSchema,
  cursor: listCursorSchema,
})

export const documentIdToolInputSchema = z.object({ id: nonEmptyStringSchema })

export const activityReadToolInputSchema = z.object({
  afterSequence: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Return events after this sequence. Pass the previous nextSequence to page."),
  aggregateType: z.string().trim().max(40).optional().describe("e.g. invoice, contact, approval"),
  aggregateId: z.string().trim().max(100).optional(),
  limit: listLimitSchema,
})

export const commandStatusToolInputSchema = z.object({ commandId: nonEmptyStringSchema })

export const COMMAND_WAIT_MAX_MS = 30_000

export const commandWaitToolInputSchema = z.object({
  commandId: nonEmptyStringSchema,
  timeoutMs: z.number().int().min(0).max(COMMAND_WAIT_MAX_MS).default(15_000),
})

export type ApprovalDecideInput = z.infer<typeof approvalDecideInputSchema>
export type AgentScopePresetId = z.infer<typeof agentScopePresetIdSchema>

/** Expected records and messages, never a claim that they have happened. */
export type CommandConsequences = {
  records: Array<{ kind: "invoice_issue" | "agreement_issue" | "agreement_acceptance" | "payment_record"; documentId: string; revision: string }>
  messages: Array<{ kind: "invoice_email" | "agreement_offer" | "agreement_accepted"; recipient: string }>
  manualSteps: Array<"share_document" | "invoice_eligible_work" | "prepayment_blocked" | "collect_payment" | "record_received_money">
  refreshWhen: "invoice_content" | "agreement_offer" | "payment_balance"
  schedule?: Array<{ id: string; title: string; amount: string; currency: string; kind: "sale" | "prepayment"; state: "future_eligibility" | "draft" | "issued"; invoiceId: string | null }>
}

export const commandPreviewInputSchema = z.object({
  commandType: z.enum(["invoice.send", "payment.record", "agreement.send", "agreement.issue", "agreement.record_acceptance"]),
  command: z.record(z.string(), z.unknown()),
  includeDocument: z.boolean().default(false),
}).strict()
