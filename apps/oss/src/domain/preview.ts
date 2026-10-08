import { createHash } from "node:crypto"
import { canonicalizeOffer } from "./agreements/snapshot"
import { actorCan, actorKey, type Actor } from "./actor"
import { resolveAgentActorById } from "./agent-actor"
import { resolveUserActor } from "./user-actor"
import type { ApprovalContext, CommandDefinition } from "./command"
import { Forbidden, InvalidState, ValidationFailed } from "./errors"
import { runScopedRead } from "./read"
import { prisma } from "../lib/db"
import { lockArtifactOrganization } from "./documents/artifacts"

export const previewCommandTypes = new Set(["invoice.send", "payment.record", "agreement.send", "agreement.issue", "agreement.record_acceptance"])

/** Binds the review to one caller, organization, parsed command input, and relevant facts. */
export function commandPreviewVersion(definition: CommandDefinition<any, any>, input: unknown, actor: Actor, review: ApprovalContext) {
  return createHash("sha256").update(canonicalizeOffer({ commandType: definition.type, input,
    organizationId: actor.organizationId, actorKey: actorKey(actor), version: review.version })).digest("hex")
}

export async function refreshPreviewActor(actor: Actor) {
  const fresh = actor.kind === "agent" ? await resolveAgentActorById(actor.agentKeyId, { allowRevoked: false })
    : actor.kind === "user" ? await resolveUserActor({ organizationId: actor.organizationId, userId: actor.userId }) : null
  if (!fresh || fresh.organizationId !== actor.organizationId) throw new Forbidden({ message: "The preview caller is no longer authorized" })
  // Authentication may attenuate the key (for example an OAuth access-token grant).
  // Refresh revocation, membership, mode and live scopes without widening that grant.
  if (fresh.kind === "agent" && actor.kind === "agent") {
    return { ...fresh, scopes: fresh.scopes.filter(scope => actor.scopes.includes(scope)) }
  }
  return fresh
}

class PreviewRollback extends Error {
  constructor(readonly review: ApprovalContext) { super("Roll back preview transaction") }
}

/** No handler, receipt, number allocation, artifact storage, email, or collection is run. */
export async function previewCommand<I>(definition: CommandDefinition<I, any>, rawInput: unknown,
  options: { actor: Actor; now?: Date }) {
  const fresh = await refreshPreviewActor(options.actor)
  if (!fresh || fresh.organizationId !== options.actor.organizationId || !actorCan(fresh, definition.permission)) {
    throw new Forbidden({ message: `Preview requires ${definition.permission}`, permission: definition.permission })
  }
  if (fresh.kind === "agent" && fresh.mode === "read_only") throw new Forbidden({ message: "This agent key is read-only" })
  if (!previewCommandTypes.has(definition.type) || !definition.approvalContext) throw new InvalidState({ code: "preview_not_supported", message: "This command has no consequence preview" })
  const parsed = definition.input.safeParse(rawInput)
  if (!parsed.success) throw new ValidationFailed({ message: "Invalid command input", issues: parsed.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) })
  const now = options.now ?? new Date()
  let review: ApprovalContext
  try {
    await prisma.$transaction(async tx => {
      await lockArtifactOrganization(tx, fresh.organizationId)
      // Roll back even on success. This also protects against an accidental future planner write.
      throw new PreviewRollback(await runScopedRead(definition.approvalContext!(parsed.data), tx, fresh, now))
    }, { maxWait: 10_000, timeout: 30_000 })
    throw new Error("Preview transaction did not roll back")
  } catch (error) {
    if (!(error instanceof PreviewRollback)) throw error
    review = error.review
  }
  return { commandType: definition.type, input: parsed.data, previewVersion: commandPreviewVersion(definition, parsed.data, fresh, review),
    reviewedAt: now.toISOString(), review }
}
