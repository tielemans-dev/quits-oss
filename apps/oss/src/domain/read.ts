import { Cause, Effect, Exit, Option } from "effect"
import type { Prisma } from "../../generated/prisma/client"
import type { Actor } from "./actor"
import { Command, Db } from "./services"

/** Preserve typed domain failures rather than wrapping them as Effect defects. */
export async function runScopedRead<T>(program: Effect.Effect<T, unknown, Db | Command>, tx: Prisma.TransactionClient,
  actor: Actor, now: Date) {
  const exit = await Effect.runPromiseExit(program.pipe(
    Effect.provideService(Db, tx), Effect.provideService(Command, {
      actor, organizationId: actor.organizationId, commandId: "reservation", now,
      approvedByUserId: null, emit: () => { throw new Error("Read cannot emit") },
      enqueue: () => { throw new Error("Read cannot enqueue") },
    })))
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.failureOption(exit.cause)
  throw Option.isSome(failure) ? failure.value : Cause.squash(exit.cause)
}
