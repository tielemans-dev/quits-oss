import { Context } from "effect"
import type { Prisma } from "../../generated/prisma/client"
import type { EventType } from "./events/registry"
import type { Actor } from "./actor"

/** The Prisma transaction a command runs in. */
export class Db extends Context.Tag("quits/Db")<Db, Prisma.TransactionClient>() {}

export type PendingEvent = {
  aggregateType: string
  aggregateId: string
  type: EventType
  payload: Record<string, unknown>
}

export type PendingJob = {
  type: string
  payload: Record<string, unknown>
  dedupeKey?: string
  runAfter?: Date
}

export type CommandScope = {
  readonly actor: Actor
  readonly organizationId: string
  readonly commandId: string
  readonly now: Date
  readonly approvedByUserId: string | null
  readonly expectedApprovalVersion?: string
  readonly issuance?: { candidateId: string; documentId: string; number: string; issuedAt: Date }
  /** Records a domain event; persisted with the command's transaction. */
  readonly emit: (event: PendingEvent) => void
  /** Queues background work; persisted with the transaction and run after commit. */
  readonly enqueue: (job: PendingJob) => void
}

export class Command extends Context.Tag("quits/Command")<Command, CommandScope>() {}
