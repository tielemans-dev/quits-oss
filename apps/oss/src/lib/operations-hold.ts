import { readBooleanEnv, readProductEnv } from "@quits/shared/runtimeEnv"
import { prisma } from "./db"
import { getRuntimeEnv } from "./runtime/platform"

const RECOVERY_STATE_ID = "default"

/**
 * Why operations are held. A restore holds them so that a copy of production never emails
 * customers, charges cards or runs jobs the original already ran. `environment` is the
 * `QUITS_OPERATIONS_HOLD` override, for instances that must never act (rehearsals, staging copies).
 */
export type OperationsHold =
  | { held: false }
  | { held: true; source: "environment" | "database"; reason: string; heldAt: Date | null }

/** Thrown by anything that would act on the outside world while operations are held. */
export class OperationsHeldError extends Error {
  override readonly name = "OperationsHeldError"
  readonly code = "operations_held"

  constructor(readonly effect: string, readonly hold: Extract<OperationsHold, { held: true }>) {
    super(
      `Operations are on hold, so ${effect} is disabled. ${hold.reason} ` +
        "Review the pending work and enable operations with `recovery enable-operations`."
    )
  }
}

/** Reads the hold from the environment override and the database. Never cached: it is one key lookup. */
export async function readOperationsHold(): Promise<OperationsHold> {
  const env = getRuntimeEnv()
  if (readBooleanEnv(readProductEnv(env, "OPERATIONS_HOLD"), false)) {
    return {
      held: true,
      source: "environment",
      reason: "QUITS_OPERATIONS_HOLD is set on this instance.",
      heldAt: null,
    }
  }
  const state = await prisma.recoveryState.findUnique({ where: { id: RECOVERY_STATE_ID } })
  if (!state || state.operationsMode === "live") {
    return { held: false }
  }
  return {
    held: true,
    source: "database",
    reason: state.heldReason ?? "This installation was restored from a backup.",
    heldAt: state.heldAt,
  }
}

export async function isOperationsHeld() {
  return (await readOperationsHold()).held
}

/** Call immediately before an action that leaves this system (a message, a charge, a request). */
export async function assertOperationsLive(effect: string) {
  const hold = await readOperationsHold()
  if (hold.held) {
    throw new OperationsHeldError(effect, hold)
  }
}

/** Records the outcome of a scheduler tick so operators can see the scheduler is alive. */
export async function recordSchedulerTick(ok: boolean, now = new Date()) {
  await prisma.recoveryState.upsert({
    where: { id: RECOVERY_STATE_ID },
    create: { id: RECOVERY_STATE_ID, lastSchedulerTickAt: now, lastSchedulerTickOk: ok },
    update: { lastSchedulerTickAt: now, lastSchedulerTickOk: ok },
  })
}
