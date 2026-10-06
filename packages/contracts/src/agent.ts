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
