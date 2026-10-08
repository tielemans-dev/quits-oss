import type { Prisma, PrismaClient } from "../../../generated/prisma/client"
import type { UserActor } from "../../domain/actor"
import { decryptSecret, encryptSecret } from "../secrets"
import { API_VERSIONS, EconomicClient, EconomicError, sha256, type Credentials } from "./client"
import { extract, preflight } from "./extraction"
import { canonical } from "./shapes"

type Tx = Prisma.TransactionClient
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

/** Internal server API. Callers supply an authenticated UserActor, never request body identities. */
export class EconomicConnector {
  constructor(private readonly db: PrismaClient, private readonly transport: typeof fetch = fetch) {}
  private async authorize(tx: Tx, actor: UserActor, write = true) {
    if (actor.kind !== "user") throw new EconomicError("forbidden")
    const member = await tx.member.findFirst({ where: { organizationId: actor.organizationId, userId: actor.userId } })
    const roles = member?.role.split(",").map(r => r.trim()) ?? []
    if (!roles.includes("admin") && (write || !roles.includes("accountant"))) throw new EconomicError("forbidden")
  }
  private async locked<T>(actor: UserActor, fn: (tx: Tx) => Promise<T>, write = true): Promise<T> {
    return this.db.$transaction(async tx => {
      // Serializes first connection creation as well as reconnect, revoke, request admission and completion.
      await tx.$queryRaw`SELECT id FROM organization WHERE id = ${actor.organizationId} FOR UPDATE`
      await this.authorize(tx, actor, write)
      return fn(tx)
    }, { timeout: 15_000, maxWait: 15_000 })
  }
  private async fence<T>(actor: UserActor, connectionId: string, generation: number, read: () => Promise<T>) {
    return this.locked(actor, async tx => {
      const current = await tx.economicConnection.findUnique({ where: { organizationId: actor.organizationId } })
      if (!current || current.id !== connectionId || current.generation !== generation || !["connecting", "connected"].includes(current.state)) throw new EconomicError("stale_connection")
      return read()
    })
  }
  async connect(actor: UserActor, expectedAccount: string, credentials: Credentials, expectedGeneration: number | null) {
    if (!/^[1-9]\d{0,14}$/.test(expectedAccount)) throw new EconomicError("invalid_response")
    if (!credentials.appSecret || !credentials.grantToken || credentials.appSecret.length > 1024 || credentials.grantToken.length > 1024 || /[\r\n]/.test(credentials.appSecret + credentials.grantToken)) throw new EconomicError("invalid_response")
    const encryptedCredentials = encryptSecret(JSON.stringify(credentials))
    const connection = await this.locked(actor, async tx => {
      const prior = await tx.economicConnection.findUnique({ where: { organizationId: actor.organizationId } })
      if (prior && prior.accountId !== expectedAccount) throw new EconomicError("account_mismatch")
      if ((prior?.generation ?? null) !== expectedGeneration) throw new EconomicError("stale_connection")
      if (prior) {
        await tx.economicReadOperation.updateMany({ where: { connectionId: prior.id, state: "pending" }, data: { state: "interrupted", failureCode: "stale_connection", finishedAt: new Date() } })
        return tx.economicConnection.update({ where: { id: prior.id }, data: { generation: { increment: 1 }, encryptedCredentials, state: "connecting", preflight: PrismaNull } })
      }
      return tx.economicConnection.create({ data: { organizationId: actor.organizationId, accountId: expectedAccount, encryptedCredentials } })
    })
    const client = new EconomicClient(credentials, { fetch: this.transport, fence: read => this.fence(actor, connection.id, connection.generation, read) })
    try {
      const result = await preflight(client)
      if (result.accountId !== expectedAccount) throw new EconomicError("account_mismatch")
      await this.locked(actor, async tx => {
        const changed = await tx.economicConnection.updateMany({ where: { id: connection.id, generation: connection.generation, state: "connecting" }, data: { state: result.readable ? "connected" : result.probes.some(p => p.state === "revoked") ? "revoked" : "failed", preflight: json(result), encryptedCredentials: result.readable ? encryptedCredentials : null } })
        if (!changed.count) throw new EconomicError("stale_connection")
      })
      return { connectionId: connection.id, generation: connection.generation, ...result }
    } catch (error) {
      const safe = error instanceof EconomicError ? error : new EconomicError("provider_unavailable")
      await this.failConnection(connection.id, connection.generation, safe.code)
      throw safe
    }
  }
  private async failConnection(id: string, generation: number, code: string) {
    await this.db.economicConnection.updateMany({ where: { id, generation, state: { in: ["connecting", "connected"] } }, data: { state: code === "revoked" ? "revoked" : "failed", encryptedCredentials: null, preflight: json({ failureCode: code }) } })
  }
  async disconnect(actor: UserActor, generation: number) {
    await this.locked(actor, async tx => {
      const connection = await tx.economicConnection.findUnique({ where: { organizationId: actor.organizationId } })
      if (!connection || connection.generation !== generation) throw new EconomicError("stale_connection")
      await tx.economicConnection.update({ where: { id: connection.id }, data: { generation: { increment: 1 }, state: "disconnected", encryptedCredentials: null } })
      await tx.economicReadOperation.updateMany({ where: { connectionId: connection.id, state: "pending" }, data: { state: "interrupted", failureCode: "stale_connection", finishedAt: new Date() } })
    })
  }
  async readState(actor: UserActor) {
    return this.locked(actor, async tx => tx.economicConnection.findUnique({ where: { organizationId: actor.organizationId }, select: { id: true, accountId: true, generation: true, state: true, preflight: true, operations: { orderBy: { createdAt: "desc" }, take: 20, select: { id: true, generation: true, state: true, failureCode: true, manifestHash: true, createdAt: true } } } }), false)
  }
  async readReport(actor: UserActor, operationId: string) {
    return this.locked(actor, async tx => tx.economicReadOperation.findFirst({ where: { id: operationId, connection: { organizationId: actor.organizationId } }, select: { id: true, state: true, failureCode: true, failureContext: true, manifest: true, manifestHash: true } }), false)
  }
  async readArtifact(actor: UserActor, evidenceId: string) {
    return this.locked(actor, async tx => tx.economicSourceEvidence.findFirst({ where: { id: evidenceId, organizationId: actor.organizationId, connection: { organizationId: actor.organizationId } }, select: { kind: true, sourceId: true, artifactState: true, artifactHash: true, artifactBytes: true } }), false)
  }
  async dryRun(actor: UserActor, generation: number, requestKey: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestKey)) throw new EconomicError("invalid_response")
    const start = await this.locked(actor, async tx => {
      const connection = await tx.economicConnection.findUnique({ where: { organizationId: actor.organizationId } })
      if (!connection || connection.generation !== generation) throw new EconomicError("stale_connection")
      const prior = await tx.economicReadOperation.findUnique({ where: { connectionId_generation_requestKey: { connectionId: connection.id, generation, requestKey } } })
      if (prior) return { connection, operation: prior, replay: true }
      if (connection.state !== "connected" || !connection.encryptedCredentials) throw new EconomicError("stale_connection")
      if (await tx.economicReadOperation.findFirst({ where: { connectionId: connection.id, state: "pending" } })) throw new EconomicError("operation_conflict")
      const operation = await tx.economicReadOperation.create({ data: { connectionId: connection.id, generation, requestKey } })
      return { connection, operation, replay: false }
    })
    if (start.replay) return { id: start.operation.id, state: start.operation.state }
    try {
      const credentials = JSON.parse(decryptSecret(start.connection.encryptedCredentials!)) as Credentials
      const client = new EconomicClient(credentials, { fetch: this.transport, fence: read => this.fence(actor, start.connection.id, generation, read) })
      const result = await extract(client, start.connection.accountId)
      await this.locked(actor, async tx => {
        const current = await tx.economicConnection.findUnique({ where: { id: start.connection.id } })
        if (!current || current.generation !== generation || current.state !== "connected") throw new EconomicError("stale_connection")
        const evidenceIds: Record<string, string> = {}
        for (const record of result.manifest.records) {
          const identity = { organizationId: actor.organizationId, provider: "economic", accountId: current.accountId, kind: record.kind, sourceId: record.sourceId }
          const artifact = result.artifacts.find(a => a.kind === record.kind && a.sourceId === record.sourceId)
          const prior = await tx.economicSourceEvidence.findUnique({ where: { organizationId_provider_accountId_kind_sourceId: identity } })
          if (prior && (prior.sourceHash !== record.sourceHash || prior.artifactHash !== (artifact?.sha256 ?? null) || prior.artifactState !== (artifact?.state ?? null))) throw new EconomicError("source_drift")
          const evidence = prior ?? await tx.economicSourceEvidence.create({ data: { ...identity, connectionId: current.id, sourceHash: record.sourceHash, apiVersions: json(API_VERSIONS), data: json({ normalized: record.data, source: record.source }), artifactState: artifact?.state, artifactHash: artifact?.sha256, artifactBytes: artifact?.content ? new Uint8Array(artifact.content) : undefined } })
          evidenceIds[`${record.kind}:${record.sourceId}`] = evidence.id
        }
        await tx.economicReadOperation.update({ where: { id: start.operation.id }, data: { state: "needs_review", manifest: json({ ...result.manifest, evidenceIds }), manifestHash: sha256(canonical({ ...result.manifest, evidenceIds })), finishedAt: new Date() } })
        await tx.economicConnection.update({ where: { id: current.id }, data: { state: "completed", encryptedCredentials: null } })
      })
      return { id: start.operation.id, state: "needs_review" }
    } catch (error) {
      const safe = error instanceof EconomicError ? error : new EconomicError("provider_unavailable")
      await this.db.economicReadOperation.updateMany({ where: { id: start.operation.id, state: "pending" }, data: { state: "failed", failureCode: safe.code, failureContext: json({ surface: safe.surface ?? null, subject: safe.subject ?? null, nextAction: safe.code === "revoked" ? "reconnect" : "review_and_start_new_extraction" }), finishedAt: new Date() } })
      await this.failConnection(start.connection.id, generation, safe.code)
      const outcome = await this.db.economicReadOperation.findUniqueOrThrow({ where: { id: start.operation.id }, select: { state: true } })
      return { id: start.operation.id, state: outcome.state }
    }
  }
}

// Prisma's JSON-null sentinel must be imported at runtime, independently of its type namespace.
import { Prisma as PrismaRuntime } from "../../../generated/prisma/client"
const PrismaNull = PrismaRuntime.DbNull
