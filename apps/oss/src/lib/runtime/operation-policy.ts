/** Distribution policies add restrictions after ordinary actor/organization authorization. */
export type RuntimeOperation = {
  organizationId: string
  kind: "command" | "job" | "procedure"
  name: string
  input: unknown
  actorKind?: "user" | "agent" | "system"
  phase: "prepare" | "execute"
}
export type OperationDecision = { allowed: true } | { allowed: false; message: string }
export type OperationPolicy = {
  authorize: (operation: Readonly<RuntimeOperation>) => Promise<OperationDecision>
}

export class OperationDenied extends Error {
  readonly code = "operation_not_allowed"
}

let policy: OperationPolicy | undefined

export function setOperationPolicy(value: OperationPolicy | undefined) { policy = value }

/** No policy means self-host behavior. Never interprets plan names, payment state or prices. */
export async function authorizeRuntimeOperation(operation: RuntimeOperation) {
  const decision = await policy?.authorize(operation)
  if (decision && !decision.allowed) throw new OperationDenied(decision.message)
}
