import { randomUUID } from "node:crypto"
import { appendFile, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PrismaPg } from "@prisma/adapter-pg"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "../../../../generated/prisma/client"
import { runDueJobs } from "../../../domain/jobs"
import { runSchedulerTick } from "../../../domain/scheduler"
import { deliver } from "../../../lib/email"
import { createStripeInvoiceCheckoutSession } from "../../../lib/payments/stripe"
import { OperationsHeldError } from "../../../lib/operations-hold"
import { resolveOrgAiProvider } from "../../../lib/ai/provider"
import { registerAiProviderFactories } from "../../../lib/ai/provider"
import { bootstrapQuitsRuntime, resetQuitsRuntimeForTests } from "../../../lib/runtime/bootstrap"
import { defaultNodePlatform } from "../../../lib/runtime/node-platform"
import { hasTestDatabase } from "../../../test-utils/organization"
import { localDiskArtifactStore } from "../../artifact-store"
import { seedRehearsalFixture } from "../fixture"
import { selfhostDocumentRenderer } from "../../runtime"
import { createBackup, recordBackup } from "../backup"
import { sha256Bytes, verifyBundle } from "../bundle"
import type { StoredArtifacts } from "../../../domain/documents/artifacts"
import { executeIssuanceCommand, prepareDocument, reserveDocument } from "../../../application/issuance"
import { createInvoiceDraft } from "../../../domain/commands/invoices"
import { resolveUserActor } from "../../../domain/user-actor"
import { documentPdf } from "../../../lib/documents/pdf-access"
import { RecoveryError } from "../../../lib/recovery/format"
import { enableOperations, reviewPendingWork, reviewToken } from "../operations"
import { queryFn } from "../../../lib/recovery/pgdb"
import { preflightRestore, restoreBundle, RestoreBlockedError } from "../restore"
import { runCli } from "../cli"
import { collectOperationalStatus } from "../../../lib/recovery/status"

const SECRET = "integration-test-secret-0123456789abcdef"
const baseUrl = process.env.DATABASE_URL

function withSchema(schema: string) {
  const url = new URL(baseUrl!)
  url.searchParams.set("options", `-c search_path=${schema}`)
  return url.toString()
}

async function migrate(schema: string) {
  const admin = new Client({ connectionString: baseUrl })
  await admin.connect()
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`SET search_path TO "${schema}"`)
    const root = new URL("../../../../prisma/migrations/", import.meta.url)
    const names = (await readdir(root)).filter((name) => /^\d/.test(name)).sort()
    await admin.query(`CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz, migration_name varchar(255) NOT NULL,
      logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`)
    for (const name of names) {
      await admin.query((await readFile(new URL(`${name}/migration.sql`, root), "utf8")).replaceAll('"public".', `"${schema}".`))
      await admin.query(`INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES ($1, 'x', now(), $2, 1)`, [randomUUID(), name])
    }
  } finally {
    await admin.end()
  }
}

/** Loopback-only SMTP adapter: accepts DATA and retains the message for assertions. */
async function startMailRelay() {
  let connections = 0
  const messages: string[] = []
  const server = net.createServer((socket) => {
    connections += 1
    socket.write("220 relay ready\r\n")
    let buffer = "", data = false, message = ""
    socket.on("data", chunk => {
      buffer += chunk.toString()
      for (;;) {
        const end = buffer.indexOf("\r\n")
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (data) {
          if (line === ".") { messages.push(message); data = false; message = ""; socket.write("250 accepted\r\n") }
          else message += `${line}\r\n`
        } else if (/^(EHLO|HELO)/.test(line)) socket.write("250 localhost\r\n")
        else if (line === "DATA") { data = true; socket.write("354 send message\r\n") }
        else if (line === "QUIT") socket.end("221 goodbye\r\n")
        else socket.write("250 OK\r\n")
      }
    })
    socket.on("error", () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: (server.address() as net.AddressInfo).port,
    connections: () => connections,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe.runIf(hasTestDatabase)("backup and isolated restore", () => {
  const sourceSchema = `rec_src_${randomUUID().replaceAll("-", "")}`
  const targetSchema = `rec_dst_${randomUUID().replaceAll("-", "")}`
  const workspace: { dir: string } = { dir: "" }
  const saved: Record<string, string | undefined> = {}
  let source: PrismaClient
  let target: PrismaClient
  let sourceClient: Client
  let targetClient: Client
  let relay: Awaited<ReturnType<typeof startMailRelay>>
  let bundle: string
  let sourceArtifacts: string
  let targetArtifacts: string
  let organizationId: string
  let invoiceIds: string[] = []
  let pendingEmailInvoiceId: string
  let pendingArtifacts: StoredArtifacts
  let stagedArtifacts: StoredArtifacts
  let storedStageId: string

  const usePlatform = (prisma: PrismaClient) =>
    bootstrapQuitsRuntime({ platform: { ...defaultNodePlatform, getPrisma: () => prisma } })

  beforeAll(async () => {
    for (const name of ["BETTER_AUTH_SECRET", "EMAIL_PROVIDER", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_REQUIRE_TLS", "FROM_EMAIL", "QUITS_OPERATIONS_HOLD", "RESEND_API_KEY"]) saved[name] = process.env[name]
    relay = await startMailRelay()
    Object.assign(process.env, {
      BETTER_AUTH_SECRET: SECRET,
      EMAIL_PROVIDER: "smtp",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(relay.port),
      SMTP_SECURE: "false",
      SMTP_REQUIRE_TLS: "false",
      FROM_EMAIL: "billing@example.test",
    })
    delete process.env.QUITS_OPERATIONS_HOLD

    workspace.dir = await mkdtemp(join(tmpdir(), "quits-recovery-it-"))
    sourceArtifacts = join(workspace.dir, "source-artifacts")
    targetArtifacts = join(workspace.dir, "target-artifacts")
    bundle = join(workspace.dir, "bundle")

    await migrate(sourceSchema)
    await migrate(targetSchema)
    source = new PrismaClient({ adapter: new PrismaPg({ connectionString: baseUrl }, { schema: sourceSchema }) })
    target = new PrismaClient({ adapter: new PrismaPg({ connectionString: baseUrl }, { schema: targetSchema }) })
    sourceClient = new Client({ connectionString: withSchema(sourceSchema) })
    targetClient = new Client({ connectionString: withSchema(targetSchema) })
    await sourceClient.connect()
    await targetClient.connect()

    // Seed the source through the real commands, the real renderer and a real artifact directory.
    usePlatform(source)
    bootstrapQuitsRuntime({ services: { documentRenderer: { ...selfhostDocumentRenderer,
      // Exercise the real preparation/store protocol with both supported formats. This small
      // test adapter is not a UBL conformance assertion; PDFs use the actual renderer.
      renderUbl: async input => new TextEncoder().encode(`<Invoice><ID>${input.number}</ID></Invoice>`),
    }, documentArtifactStore: localDiskArtifactStore(sourceArtifacts) } })
    const fixture = await seedRehearsalFixture()
    organizationId = fixture.organizationId
    invoiceIds = fixture.invoiceIds
    pendingEmailInvoiceId = fixture.pendingEmailInvoiceId
    const candidate = await source.issuanceCandidate.findFirstOrThrow({ where: { documentId: pendingEmailInvoiceId, status: "bound" }, include: { staging: true } })
    expect(candidate.staging.status).toBe("candidate_bound")
    expect(candidate.artifacts).toEqual(candidate.staging.artifacts)
    pendingArtifacts = candidate.artifacts as StoredArtifacts
    expect(pendingArtifacts.ubl).toBeTruthy()
    expect(await source.invoice.findUniqueOrThrow({ where: { id: pendingEmailInvoiceId } })).toMatchObject({ status: "draft", artifactPdfRef: null })
    const member = await source.member.findFirstOrThrow({ where: { organizationId } })
    const actor = (await resolveUserActor({ organizationId, userId: member.userId }))!
    const contact = await source.contact.findFirstOrThrow({ where: { organizationId } })
    const draft = await executeIssuanceCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2099-12-01", currency: "USD",
      taxRate: 0, items: [{ description: "Prepared retry", quantity: 1, unitPrice: 3 }] }, { actor })
    if (draft.status !== "completed") throw new Error("Fixture draft failed")
    const reservation = await reserveDocument({ kind: "invoice", commandInput: { id: draft.result.id }, actor, clientRequestId: randomUUID() })
    const prepared = await prepareDocument(reservation.id)
    expect(prepared.status).toBe("stored")
    storedStageId = prepared.id
    stagedArtifacts = prepared.artifacts as StoredArtifacts
    expect(await source.issuanceCandidate.count({ where: { stagingId: storedStageId } })).toBe(0)
    console.log(`Recovery loopback SMTP reservation: 127.0.0.1:${relay.port}`)
  }, 120_000)

  afterAll(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    resetQuitsRuntimeForTests()
    await Promise.allSettled([source?.$disconnect(), target?.$disconnect(), sourceClient?.end(), targetClient?.end(), relay?.close()])
    const admin = new Client({ connectionString: baseUrl })
    await admin.connect()
    for (const schema of [sourceSchema, targetSchema]) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
    if (workspace.dir) await rm(workspace.dir, { recursive: true, force: true })
  }, 60_000)

  const options = (extra: Partial<Parameters<typeof restoreBundle>[0]> = {}) => ({
    client: targetClient,
    artifactStore: localDiskArtifactStore(targetArtifacts),
    bundle,
    env: { ...process.env } as Record<string, string | undefined>,
    appVersion: "test",
    ...extra,
  })

  async function expectTargetEmpty() {
    for (const table of ["organization", "invoice", "payment", "credit_note", "contact"]) {
      expect((await targetClient.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0)
    }
  }

  it("writes a versioned bundle whose totals match the data by currency", async () => {
    const result = await createBackup({
      client: sourceClient,
      artifactStore: localDiskArtifactStore(sourceArtifacts),
      directory: bundle,
      env: { ...process.env },
      appVersion: "test",
    })
    const { manifest } = result
    expect(manifest).toMatchObject({ format: "quits-backup", formatVersion: 1 })
    expect(manifest.source.migrations.at(-1)).toMatch(/recovery_state/)
    // 100 x 2 + 25% tax, paid in full; 80.50 x 2 + 25%, 20.25 paid after a voided 50; DKK credited 250.
    expect(manifest.totals.USD).toMatchObject({ invoices: { count: 1, gross: "250.00", paid: "100.00" }, payments: { count: 1, amount: "100.00", voidedCount: 0 } })
    expect(manifest.totals.EUR).toMatchObject({ invoices: { count: 1, gross: "201.25", paid: "20.25" }, payments: { count: 1, amount: "20.25", voidedCount: 1, voidedAmount: "50.00" } })
    expect(manifest.totals.DKK.creditNotes).toMatchObject({ count: 1, gross: "250.00" })
    expect(manifest.artifacts.objects.length).toBeGreaterThanOrEqual(4)
    expect(manifest.artifacts.missing).toEqual([])
    expect(manifest.pendingWork).toMatchObject({ jobsPending: expect.any(Number), remindersDue: 1, recurringDue: 1 })
    expect(manifest.pendingWork.jobsByType["email.deliver"]).toBeGreaterThanOrEqual(1)
    expect(manifest.database.excluded.map((entry) => entry.table)).toEqual(expect.arrayContaining(["session", "verification", "scheduler_scan"]))
    // Secrets: fingerprints only, never a key or a decrypted value.
    const text = await readFile(join(bundle, "manifest.json"), "utf8")
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain("sk_test_rehearsal")
    expect(manifest.keys.encryptedValues).toBe(2)
    const check = await verifyBundle(bundle)
    expect(check.findings).toEqual([])
    expect(check.manifestSha256).toBe(result.manifestSha256)
  }, 60_000)

  it("bundles both formats owned only by a pending candidate and its staging row", async () => {
    const { manifest } = await verifyBundle(bundle)
    for (const artifact of [pendingArtifacts.pdf, pendingArtifacts.ubl!, stagedArtifacts.pdf, stagedArtifacts.ubl!]) {
      const objects = manifest.artifacts.objects.filter(object => object.ref === artifact.ref)
      expect(objects).toHaveLength(1)
      expect(objects[0]).toMatchObject({ sha256: artifact.hash, bytes: artifact.size })
      expect(await readFile(join(bundle, objects[0]!.file))).toEqual(await readFile(join(sourceArtifacts, artifact.ref)))
    }
  })

  it("records the backup so the application can report its age", async () => {
    const status = await collectOperationalStatus({ query: queryFn(sourceClient), env: { EMAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", FROM_EMAIL: "a@b.test" }, artifactStore: localDiskArtifactStore(sourceArtifacts), environmentHold: false })
    expect(status.backups.ageHours).toBeLessThan(1)
    expect(status.backups.stale).toBe(false)
    expect(status.artifacts).toMatchObject({ missingObjects: 0, mismatched: 0 })
    expect(status.artifacts.checked).toBeGreaterThanOrEqual(4)
    expect(status.mail).toMatchObject({ provider: "smtp", configured: true })
    expect(status.scheduler.pendingJobs).toBeGreaterThanOrEqual(1)
    expect(status.problems.map((problem) => problem.code)).toContain("scheduler_silent")
  })

  it("records verification time separately from the actual bundle snapshot", async () => {
    const { manifest, manifestSha256 } = await verifyBundle(bundle)
    const at = new Date("2026-10-08T12:00:00Z")
    await sourceClient.query("BEGIN")
    try {
      await sourceClient.query("DELETE FROM backup_record")
      const old = { ...manifest, createdAt: "2026-09-01T12:00:00Z" }
      await recordBackup(queryFn(sourceClient), "verified", old, manifestSha256)
      await sourceClient.query(`UPDATE backup_record SET "createdAt" = '2026-10-08 12:00:00'`)
      const status = () => collectOperationalStatus({ query: queryFn(sourceClient), env: {}, environmentHold: true, artifactCheckLimit: 0, now: at })
      expect((await status()).backups).toMatchObject({ ageHours: 888, stale: true, verificationAgeHours: 0 })
      await recordBackup(queryFn(sourceClient), "created", { ...manifest, createdAt: "2026-10-08T06:00:00Z" }, manifestSha256)
      await recordBackup(queryFn(sourceClient), "verified", old, manifestSha256)
      expect((await status()).backups).toMatchObject({ ageHours: 6, stale: false })
    } finally {
      await sourceClient.query("ROLLBACK")
    }
  })

  describe("pending source artifacts", () => {
    it.each(["pdf", "ubl"] as const)("refuses absent and corrupt candidate %s bytes and records explicit incomplete gaps", async format => {
      const artifact = pendingArtifacts[format]!
      const path = join(sourceArtifacts, artifact.ref)
      const original = await readFile(path)
      try {
        for (const corrupt of [false, true]) {
          if (corrupt) await writeFile(path, Buffer.alloc(original.length))
          else await rm(path)
          const create = (allowIncomplete: boolean) => createBackup({ client: sourceClient, artifactStore: localDiskArtifactStore(sourceArtifacts),
            directory: join(workspace.dir, `bad-source-${format}-${corrupt}-${allowIncomplete}`), env: { ...process.env }, appVersion: "test", allowIncomplete, record: false })
          await expect(create(false)).rejects.toMatchObject({ code: "artifacts_incomplete" })
          const { manifest } = await create(true)
          expect(manifest.artifacts.missing).toEqual(expect.arrayContaining([
            expect.objectContaining({ table: "issuance_candidate", ref: artifact.ref, problem: corrupt ? "hash_mismatch" : "object_missing" }),
            expect.objectContaining({ table: "artifact_staging", ref: artifact.ref, problem: corrupt ? "hash_mismatch" : "object_missing" }),
          ]))
        }
      } finally { await writeFile(path, original) }
    })

    it.each(["pdf", "ubl"] as const)("refuses absent and corrupt unbound staging %s bytes", async format => {
      const path = join(sourceArtifacts, stagedArtifacts[format]!.ref)
      const original = await readFile(path)
      try {
        for (const corrupt of [false, true]) {
          if (corrupt) await writeFile(path, Buffer.alloc(original.length))
          else await rm(path)
          await expect(createBackup({ client: sourceClient, artifactStore: localDiskArtifactStore(sourceArtifacts),
            directory: join(workspace.dir, `bad-staging-${format}-${corrupt}`), env: { ...process.env }, appVersion: "test", record: false })).rejects.toMatchObject({ code: "artifacts_incomplete" })
        }
      } finally { await writeFile(path, original) }
    })

    it.each(["issuance_candidate", "artifact_staging"])("refuses missing or malformed required %s references", async table => {
      const candidate = await source.issuanceCandidate.findFirstOrThrow({ where: { documentId: pendingEmailInvoiceId } })
      const id = table === "issuance_candidate" ? candidate.id : candidate.stagingId
      const original = (await sourceClient.query(`SELECT artifacts FROM "${table}" WHERE id = $1`, [id])).rows[0].artifacts
      try {
        for (const artifacts of [null, { pdf: pendingArtifacts.pdf, ubl: { ref: pendingArtifacts.ubl!.ref } }]) {
          await sourceClient.query(`UPDATE "${table}" SET artifacts = $1::jsonb WHERE id = $2`, [artifacts === null ? null : JSON.stringify(artifacts), id])
          await expect(createBackup({ client: sourceClient, artifactStore: localDiskArtifactStore(sourceArtifacts),
            directory: join(workspace.dir, `invalid-${table}-${artifacts === null}`), env: { ...process.env }, appVersion: "test", record: false })).rejects.toMatchObject({ code: "artifacts_incomplete" })
        }
      } finally { await sourceClient.query(`UPDATE "${table}" SET artifacts = $1::jsonb WHERE id = $2`, [JSON.stringify(original), id]) }
    })

    it("retains expired unswept staging, bound candidates and protected retired work", async () => {
      const candidate = await source.issuanceCandidate.findFirstOrThrow({ where: { documentId: pendingEmailInvoiceId } })
      const stage = await source.artifactStaging.findUniqueOrThrow({ where: { id: candidate.stagingId } })
      const job = await source.job.findFirstOrThrow({ where: { type: "email.deliver", status: "pending" } })
      const stored = await source.artifactStaging.findUniqueOrThrow({ where: { id: storedStageId } })
      const backup = async (name: string) => (await createBackup({ client: sourceClient, artifactStore: localDiskArtifactStore(sourceArtifacts),
        directory: join(workspace.dir, name), env: { ...process.env }, appVersion: "test", record: false })).manifest.artifacts.objects.map(object => object.ref)
      try {
        await source.artifactStaging.updateMany({ where: { id: { in: [stage.id, stored.id] } }, data: { leaseUntil: new Date(0) } })
        expect(await backup("expired-unswept")).toEqual(expect.arrayContaining([pendingArtifacts.pdf.ref, stagedArtifacts.pdf.ref]))
        await source.issuanceCandidate.update({ where: { id: candidate.id }, data: { status: "retired" } })
        await source.artifactStaging.update({ where: { id: stage.id }, data: { status: "abandoned" } })
        await source.job.update({ where: { id: job.id }, data: { status: "failed", result: { status: "definitely_not_accepted" } } })
        expect(await backup("recent-retired")).toContain(pendingArtifacts.pdf.ref)
        // Test the UTC retention boundary in SQL and offset-free PostgreSQL bundle JSON.
        await source.issuanceCandidate.update({ where: { id: candidate.id }, data: { createdAt: new Date(Date.now() - 7 * 24 * 3600_000 + 30 * 60_000) } })
        expect(await backup("retired-near-boundary")).toContain(pendingArtifacts.pdf.ref)
        const timezone = process.env.TZ
        try {
          process.env.TZ = "Asia/Tokyo"
          const path = join(workspace.dir, "retired-near-boundary", "manifest.json")
          const manifest = JSON.parse(await readFile(path, "utf8"))
          manifest.artifacts.objects = manifest.artifacts.objects.filter((object: { ref: string }) => object.ref !== pendingArtifacts.pdf.ref)
          await writeFile(path, JSON.stringify(manifest))
          expect((await verifyBundle(join(workspace.dir, "retired-near-boundary"))).findings).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "backup_object_not_bundled", message: expect.stringContaining(pendingArtifacts.pdf.ref) }),
          ]))
        } finally {
          if (timezone === undefined) delete process.env.TZ
          else process.env.TZ = timezone
        }
        await source.issuanceCandidate.update({ where: { id: candidate.id }, data: { createdAt: new Date(0) } })
        expect(await backup("old-retired")).not.toContain(pendingArtifacts.pdf.ref)
        // An unknown provider outcome keeps even old retired work protected.
        await sourceClient.query(`UPDATE job SET result = NULL WHERE id = $1`, [job.id])
        expect(await backup("old-unsettled")).toContain(pendingArtifacts.pdf.ref)
      } finally {
        await source.issuanceCandidate.update({ where: { id: candidate.id }, data: { status: candidate.status, createdAt: candidate.createdAt } })
        await source.artifactStaging.update({ where: { id: stage.id }, data: { status: stage.status, leaseUntil: stage.leaseUntil, updatedAt: stage.updatedAt } })
        await source.artifactStaging.update({ where: { id: stored.id }, data: { leaseUntil: stored.leaseUntil, updatedAt: stored.updatedAt } })
        await sourceClient.query(`UPDATE job SET status = $1, result = $2::jsonb, "updatedAt" = $4::timestamptz AT TIME ZONE 'UTC' WHERE id = $3`, [job.status, job.result === null ? null : JSON.stringify(job.result), job.id, job.updatedAt])
      }
    })

    it.each(["issuance_candidate", "artifact_staging"])("refuses contradictory %s hashes even for duplicate references", async table => {
      const candidate = await source.issuanceCandidate.findFirstOrThrow({ where: { documentId: pendingEmailInvoiceId } })
      const id = table === "issuance_candidate" ? candidate.id : candidate.stagingId
      const original = (await sourceClient.query(`SELECT artifacts FROM "${table}" WHERE id = $1`, [id])).rows[0].artifacts
      await sourceClient.query(`UPDATE "${table}" SET artifacts = jsonb_set(artifacts, '{pdf,hash}', $1::jsonb) WHERE id = $2`, [JSON.stringify("0".repeat(64)), id])
      try {
        await expect(createBackup({ client: sourceClient, artifactStore: localDiskArtifactStore(sourceArtifacts),
          directory: join(workspace.dir, `disagree-${table}`), env: { ...process.env }, appVersion: "test", record: false })).rejects.toMatchObject({ code: "artifacts_incomplete" })
      } finally { await sourceClient.query(`UPDATE "${table}" SET artifacts = $1::jsonb WHERE id = $2`, [JSON.stringify(original), id]) }
    })
  })

  describe("a restore that cannot be done", () => {
    const blocked = async (extra: Partial<Parameters<typeof restoreBundle>[0]>, code: string) => {
      const error = await restoreBundle(options(extra)).catch((caught) => caught)
      expect(error).toBeInstanceOf(RestoreBlockedError)
      expect((error as RestoreBlockedError).findings.map((finding) => finding.code)).toContain(code)
      await expectTargetEmpty()
      return (error as RestoreBlockedError).findings.find((finding) => finding.code === code)!
    }

    it("stops before writing when the key is missing, and says which to set", async () => {
      const env = { ...process.env } as Record<string, string | undefined>
      delete env.BETTER_AUTH_SECRET
      const finding = await blocked({ env }, "missing_key")
      expect(finding.action).toContain("BETTER_AUTH_SECRET")
    })

    it("stops before writing when the key is different", async () => {
      await blocked({ env: { ...process.env, BETTER_AUTH_SECRET: "a-different-secret-0123456789abcdef" } }, "wrong_key")
    })

    it("stops before writing when an artifact in the bundle is corrupt", async () => {
      const copy = join(workspace.dir, "corrupt-bundle")
      await cp(bundle, copy, { recursive: true })
      const { manifest } = await verifyBundle(copy)
      await appendFile(join(copy, manifest.artifacts.objects[0]!.file), "tampered")
      await blocked({ bundle: copy }, "size_mismatch")
    })

    it("stops before writing when an artifact object is missing from the bundle", async () => {
      const copy = join(workspace.dir, "missing-bundle")
      await cp(bundle, copy, { recursive: true })
      const { manifest } = await verifyBundle(copy)
      await rm(join(copy, manifest.artifacts.objects[1]!.file))
      const finding = await blocked({ bundle: copy }, "artifact_object_missing")
      expect(finding.message).toContain(manifest.artifacts.objects[1]!.file)
    })

    it.each(["pdf", "ubl"] as const)("rejects an old v1 inventory that omits the pending %s", async format => {
      const copy = join(workspace.dir, `old-v1-${format}`)
      await cp(bundle, copy, { recursive: true })
      const manifest = JSON.parse(await readFile(join(copy, "manifest.json"), "utf8"))
      const ref = pendingArtifacts[format]!.ref
      manifest.artifacts.objects = manifest.artifacts.objects.filter((object: { ref: string }) => object.ref !== ref)
      manifest.artifacts.missing = [] // Original v1 collector reported no gaps.
      await rm(join(copy, "artifacts", ref), { force: true })
      await writeFile(join(copy, "manifest.json"), JSON.stringify(manifest))
      const finding = await blocked({ bundle: copy }, "backup_object_not_bundled")
      expect(finding.message).toContain(ref)
      expect(finding.action).toBeTruthy()
    })

    it("refuses conflicting duplicate object inventory entries", async () => {
      const copy = join(workspace.dir, "duplicate-inventory")
      await cp(bundle, copy, { recursive: true })
      const manifest = JSON.parse(await readFile(join(copy, "manifest.json"), "utf8"))
      const object = manifest.artifacts.objects.find((object: { ref: string }) => object.ref === pendingArtifacts.pdf.ref)
      manifest.artifacts.objects.push({ ...object, sha256: "0".repeat(64) })
      await writeFile(join(copy, "manifest.json"), JSON.stringify(manifest))
      await blocked({ bundle: copy }, "artifact_duplicate_reference")
    })

    it("refuses metadata with the right hash but the wrong document identity", async () => {
      const copy = join(workspace.dir, "wrong-object-owner")
      await cp(bundle, copy, { recursive: true })
      const manifest = JSON.parse(await readFile(join(copy, "manifest.json"), "utf8"))
      const object = manifest.artifacts.objects.find((object: { ref: string }) => object.ref === pendingArtifacts.pdf.ref)
      const metadata = JSON.parse(await readFile(join(copy, object.metaFile), "utf8"))
      await writeFile(join(copy, object.metaFile), JSON.stringify({ ...metadata, documentId: "another-document" }))
      await blocked({ bundle: copy }, "backup_metadata_identity_mismatch")
    })

    it("validates target bytes independently of a store's successful put and head", async () => {
      const disk = localDiskArtifactStore(join(workspace.dir, "faulty-store"))
      const store = { ...disk, get: async (ref: string) => ref === pendingArtifacts.pdf.ref ? new Uint8Array([0]) : disk.get(ref) }
      await expect(restoreBundle(options({ artifactStore: store }))).rejects.toMatchObject({ code: "artifacts_unverified" })
      await expectTargetEmpty()
    })

    it("rejects a backup format this release cannot read", async () => {
      const copy = join(workspace.dir, "future-bundle")
      await cp(bundle, copy, { recursive: true })
      const manifest = JSON.parse(await readFile(join(copy, "manifest.json"), "utf8"))
      await writeFile(join(copy, "manifest.json"), JSON.stringify({ ...manifest, formatVersion: 7 }))
      await expect(restoreBundle(options({ bundle: copy }))).rejects.toMatchObject({ code: "unsupported_format_version" })
      await expectTargetEmpty()
    })

    it("rejects a backup from a newer schema than the target", async () => {
      const copy = join(workspace.dir, "newer-bundle")
      await cp(bundle, copy, { recursive: true })
      const manifest = JSON.parse(await readFile(join(copy, "manifest.json"), "utf8"))
      manifest.source.migrations.push("29991231000000_from_the_future")
      await writeFile(join(copy, "manifest.json"), JSON.stringify(manifest))
      const finding = await blocked({ bundle: copy }, "target_older_than_backup")
      expect(finding.action).toContain("Install Quits")
    })

    it("rejects a target that was never migrated", async () => {
      const scratch = `rec_bare_${randomUUID().replaceAll("-", "")}`
      const admin = new Client({ connectionString: baseUrl })
      await admin.connect()
      try {
        await admin.query(`CREATE SCHEMA "${scratch}"`)
        await admin.query(`SET search_path TO "${scratch}"`)
        const preflight = await preflightRestore(options({ client: admin }))
        expect(preflight.restorable).toBe(false)
        expect(preflight.findings.map((finding) => finding.code)).toContain("target_not_migrated")
      } finally {
        await admin.query(`DROP SCHEMA "${scratch}" CASCADE`)
        await admin.end()
      }
    })

    it("can be rehearsed without production keys, with a warning", async () => {
      const preflight = await preflightRestore(options({ env: {}, skipKeyCheck: true }))
      expect(preflight.restorable).toBe(true)
      expect(preflight.keys).toBe("skipped")
      expect(preflight.findings.map((finding) => finding.code)).toContain("keys_not_checked")
    })

    it("rolls back completely when restored totals do not match the manifest", async () => {
      const copy = join(workspace.dir, "bad-totals-bundle")
      await cp(bundle, copy, { recursive: true })
      const manifest = JSON.parse(await readFile(join(copy, "manifest.json"), "utf8"))
      manifest.totals.USD.invoices.gross = "999.99"
      await writeFile(join(copy, "manifest.json"), JSON.stringify(manifest))
      await expect(restoreBundle(options({ bundle: copy }))).rejects.toMatchObject({ code: "totals_mismatch", message: expect.stringContaining("USD invoices.gross") })
      await expectTargetEmpty()
    })
  })

  describe("a restore rehearsal", () => {
    let report: Awaited<ReturnType<typeof restoreBundle>>

    it("restores a representative backup into a clean installation and reports the source and results", async () => {
      report = await restoreBundle(options())
      expect(report).toMatchObject({
        sourceAppVersion: "test",
        gates: { integrity: "pass", artifacts: "pass", totals: "pass", rows: "pass", keys: "pass" },
      })
      expect(report.artifactsVerified).toBeGreaterThanOrEqual(4)
      expect(report.sourceLastMigration).toMatch(/recovery_state/)
    }, 60_000)

    it("restores every row exactly, including exact decimals and JSON", async () => {
      const tables = (await verifyBundle(bundle)).manifest.database.tables
      for (const table of tables) {
        const read = async (client: Client) => (await client.query(`SELECT to_jsonb(t)::text AS row FROM "${table.name}" t ORDER BY to_jsonb(t)::text`)).rows.map((row) => row.row)
        expect(await read(targetClient), table.name).toEqual(await read(sourceClient))
      }
    })

    it("restores invoice, credit and payment totals that match the manifest by currency", async () => {
      usePlatform(target)
      const sums = await target.invoice.groupBy({ by: ["currency"], where: { status: { not: "draft" } }, _sum: { totalGross: true, amountPaid: true } })
      const byCurrency = Object.fromEntries(sums.map((row) => [row.currency, row._sum]))
      expect(byCurrency.USD?.totalGross?.toString()).toBe("250")
      expect(byCurrency.EUR?.totalGross?.toString()).toBe("201.25")
      expect(byCurrency.EUR?.amountPaid?.toString()).toBe("20.25")
      expect((await target.creditNote.aggregate({ where: { currency: "DKK" }, _sum: { totalGross: true } }))._sum.totalGross?.toString()).toBe("250")
      expect((await target.payment.aggregate({ where: { currency: "EUR", voidedAt: { not: null } }, _sum: { amount: true } }))._sum.amount?.toString()).toBe("50")
    })

    it("restores issued PDFs that verify against their recorded hashes", async () => {
      const store = localDiskArtifactStore(targetArtifacts)
      const invoices = await target.invoice.findMany({ where: { id: { in: invoiceIds } } })
      expect(invoices.length).toBe(3)
      for (const invoice of invoices) {
        expect(invoice.artifactPdfRef).toBeTruthy()
        expect((await store.head(invoice.artifactPdfRef!))?.hash).toBe(invoice.artifactPdfHash)
        const bytes = await store.get(invoice.artifactPdfRef!)
        expect(Buffer.from(bytes!.slice(0, 4)).toString()).toBe("%PDF")
      }
    })

    it("leaves the installation held, with the pending work intact", async () => {
      const state = await target.recoveryState.findUniqueOrThrow({ where: { id: "default" } })
      expect(state.operationsMode).toBe("held")
      expect(state.restoredFrom).toMatchObject({ bundleId: report.bundleId })
      const pending = await target.job.count({ where: { status: "pending" } })
      expect(pending).toBe(report.pendingWork.jobsPending)
      expect(pending).toBeGreaterThanOrEqual(1)
    })

    it("sends no message, makes no charge and runs no job, even with work pending and mail configured", async () => {
      usePlatform(target)
      const before = await target.job.findMany({ orderBy: { id: "asc" } })
      const remindersBefore = await target.invoiceReminder.findMany()
      await import("../../../domain/scheduler-tasks")

      expect(await runSchedulerTick()).toEqual({ operationsHold: { held: 1 } })
      expect(await runDueJobs()).toMatchObject({ processed: 0, succeeded: 0, deferred: before.filter((job) => job.status === "pending").length })
      await expect(deliver({ from: "a@b.test", to: "c@d.test", subject: "x", html: "x" })).rejects.toBeInstanceOf(OperationsHeldError)
      await expect(
        createStripeInvoiceCheckoutSession({
          credentials: { publishableKey: "pk", secretKey: "sk_test_x", webhookSecret: "wh" },
          invoice: { id: "i", number: "1", organizationId, currency: "USD" },
          amountDue: 10,
          successUrl: "https://example.test/ok",
          cancelUrl: "https://example.test/no",
        })
      ).rejects.toBeInstanceOf(OperationsHeldError)
      registerAiProviderFactories({ openaiCompatible: () => ({ id: "openrouter", complete: async () => "should not run" }), cliAgent: () => ({ id: "cli_agent", complete: async () => "should not run" }) })
      await expect(
        resolveOrgAiProvider({ provider: "openrouter", apiKey: "k", baseUrl: null, model: "m" }).complete({ model: "m", messages: [] })
      ).rejects.toMatchObject({ code: "disabled" })

      expect(relay.connections()).toBe(0)
      expect(await target.job.findMany({ orderBy: { id: "asc" } })).toEqual(before)
      expect(await target.invoiceReminder.findMany()).toEqual(remindersBefore)
    })

    it("reports the held state and pending work through the status check", async () => {
      const status = await collectOperationalStatus({ query: queryFn(targetClient), env: { ...process.env }, artifactStore: localDiskArtifactStore(targetArtifacts), environmentHold: false })
      expect(status.operations).toMatchObject({ held: true, source: "database" })
      expect(status.problems.map((problem) => problem.code)).toContain("operations_held")
      expect(status.artifacts).toMatchObject({ missingObjects: 0, mismatched: 0 })
    })

    it("refuses to re-enable operations until pending work is reviewed and the source is confirmed stopped", async () => {
      const review = await reviewPendingWork(queryFn(targetClient))
      const token = reviewToken(review)
      expect(review.jobs.some((job) => job.type === "email.deliver")).toBe(true)
      expect(review.remindersDue).toBe(1)
      expect(review.recurringDue).toBe(1)
      expect(review.duplicateExecutionControls.length).toBeGreaterThan(0)

      const attempt = (extra: Partial<Parameters<typeof enableOperations>[0]>) =>
        enableOperations({ client: targetClient, reviewToken: token, jobs: "keep", sourceStopped: true, ...extra })
      await expect(attempt({ reviewToken: "0000000000000000" })).rejects.toMatchObject({ code: "review_stale" })
      await expect(attempt({ sourceStopped: false })).rejects.toMatchObject({ code: "source_not_confirmed" })
      expect((await target.recoveryState.findUniqueOrThrow({ where: { id: "default" } })).operationsMode).toBe("held")

      await target.job.create({ data: { organizationId, type: "email.deliver", payload: {} } })
      await expect(attempt({})).rejects.toBeInstanceOf(RecoveryError) // the work changed after the review
      await target.job.deleteMany({ where: { payload: { equals: {} } } })
    })

    it.each(["identity", "payload"])("rejects a changed email %s with identical counts and dates without exposing its payload", async (change) => {
      const job = await target.job.findFirstOrThrow({ where: { status: "pending" } })
      const before = await reviewPendingWork(queryFn(targetClient))
      // No timestamp/version bump: each change independently invalidates the review.
      const newId = change === "identity" ? `${job.id}-replacement` : job.id
      const payload = change === "payload" ? { to: "private-replacement@example.test", documentId: "different-document" } : job.payload
      await targetClient.query(`UPDATE job SET id = $1, payload = $2::jsonb WHERE id = $3`, [newId, JSON.stringify(payload), job.id])
      try {
        const after = await reviewPendingWork(queryFn(targetClient))
        expect(after.jobs).toEqual(before.jobs)
        expect(reviewToken(after)).not.toBe(reviewToken(before))
        expect(JSON.stringify(after)).not.toContain("private-replacement")
        const output: string[] = []
        const env = { ...process.env, DATABASE_URL: withSchema(targetSchema) }
        const io = { out: (line: string) => output.push(line), err: (line: string) => output.push(line) }
        expect(await runCli(["review", "--json"], env, io)).toBe(0)
        expect(output.join("\n")).not.toContain("private-replacement")
        expect(JSON.parse(output[0]!).reviewToken).toBe(reviewToken(after))
        expect(await runCli(["enable-operations", "--review-token", reviewToken(before), "--jobs", "keep", "--source-stopped"], env, io)).toBe(1)
        await expect(enableOperations({ client: targetClient, reviewToken: reviewToken(before), jobs: "keep", sourceStopped: true })).rejects.toMatchObject({ code: "review_stale" })
      } finally {
        await targetClient.query(`UPDATE job SET id = $1, payload = $2::jsonb WHERE id = $3`, [job.id, JSON.stringify(job.payload), newId])
      }
    })

    it("binds recurring terms, reminders, linked document data and new business tables", async () => {
      const mutations = [
        `UPDATE recurring_invoice SET "dueInDays" = "dueInDays" + 1`,
        `UPDATE invoice_reminder SET "scheduledFor" = "scheduledFor" - interval '1 minute'`,
        `UPDATE invoice SET notes = 'changed after review'`,
        `UPDATE domain_event SET payload = payload || '{"recoveryTestChanged":true}'::jsonb`,
        `CREATE TABLE recovery_test_future_delivery (id text, payload jsonb)`,
      ]
      for (const sql of mutations) {
        const before = reviewToken(await reviewPendingWork(queryFn(targetClient)))
        // Exercise direct writes too: the protocol must not depend on Prisma timestamp bumps.
        await targetClient.query("BEGIN")
        await targetClient.query(sql)
        await targetClient.query("COMMIT")
        try {
          expect(reviewToken(await reviewPendingWork(queryFn(targetClient)))).not.toBe(before)
          await expect(enableOperations({ client: targetClient, reviewToken: before, jobs: "keep", sourceStopped: true })).rejects.toMatchObject({ code: "review_stale" })
        } finally {
          if (sql.startsWith("CREATE")) await targetClient.query("DROP TABLE recovery_test_future_delivery")
        }
      }
    })

    it("detects a real writer committing between BEGIN and validation", async () => {
      const writer = new Client({ connectionString: withSchema(targetSchema) })
      await writer.connect()
      const token = reviewToken(await reviewPendingWork(queryFn(targetClient)))
      const client = { query: async (sql: string, params?: unknown[]) => {
        const result = await targetClient.query(sql, params)
        if (sql.startsWith("BEGIN")) await writer.query(`UPDATE recurring_invoice SET "dueInDays" = "dueInDays" + 1`)
        return result
      } } as unknown as Client
      try {
        await expect(enableOperations({ client, reviewToken: token, jobs: "keep", sourceStopped: true })).rejects.toMatchObject({ code: "review_stale" })
        expect((await target.recoveryState.findUniqueOrThrow({ where: { id: "default" } })).operationsMode).toBe("held")
      } finally {
        await writer.end()
      }
    })

    it("refuses cutover while a real enqueue transaction is uncommitted", async () => {
      const token = reviewToken(await reviewPendingWork(queryFn(targetClient)))
      const writer = new Client({ connectionString: withSchema(targetSchema) })
      await writer.connect()
      try {
        await writer.query("BEGIN")
        await writer.query(`INSERT INTO job (id, "organizationId", type, payload, "updatedAt") VALUES ('concurrent-enqueue', $1, 'email.deliver', '{}', now())`, [organizationId])
        await expect(enableOperations({ client: targetClient, reviewToken: token, jobs: "keep", sourceStopped: true })).rejects.toMatchObject({ code: "cutover_busy" })
        expect((await target.recoveryState.findUniqueOrThrow({ where: { id: "default" } })).operationsMode).toBe("held")
      } finally {
        await writer.query("ROLLBACK")
        await writer.end()
      }
    })

    it("requires an explicit exception to enable a rehearsal without production keys", async () => {
      const state = await target.recoveryState.findUniqueOrThrow({ where: { id: "default" } })
      await targetClient.query(`UPDATE recovery_state SET "restoreReport" = jsonb_set("restoreReport", '{gates,keys}', '"skipped"')`)
      const token = reviewToken(await reviewPendingWork(queryFn(targetClient)))
      await expect(enableOperations({ client: targetClient, reviewToken: token, jobs: "keep", sourceStopped: true })).rejects.toMatchObject({ code: "gates_not_passed", message: expect.stringContaining("keys (skipped)") })
      const enabled = await enableOperations({ client: targetClient, reviewToken: token, jobs: "keep", sourceStopped: true, acceptedGates: ["keys"] })
      expect(enabled).toMatchObject({ cutover: "acknowledged_exception", acceptedGates: ["keys"] })
      const exception = await target.recoveryState.findUniqueOrThrow({ where: { id: "default" } })
      expect(exception.restoreReport).toMatchObject({ gates: { keys: "skipped" }, enabled: { cutover: "acknowledged_exception", acceptedGates: ["keys"] } })
      await targetClient.query(`UPDATE recovery_state SET "operationsMode" = 'held', "restoreReport" = $1::jsonb`, [JSON.stringify(state.restoreReport)])
    })

    it("holds real enqueue, reminder and recurrence writers out of validation until commit", async () => {
      const token = reviewToken(await reviewPendingWork(queryFn(targetClient)))
      const writer = new Client({ connectionString: withSchema(targetSchema) })
      await writer.connect()
      await writer.query("SET lock_timeout = '100ms'")
      let checked = false
      const client = { query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('SELECT "operationsMode"')) {
          // This hook only schedules another real connection. PostgreSQL enforces the exclusion.
          for (const statement of [
            `INSERT INTO job (id, "organizationId", type, payload, "updatedAt") VALUES ('locked-enqueue', $1, 'email.deliver', '{}', now())`,
            `UPDATE invoice_reminder SET "scheduledFor" = "scheduledFor" + interval '1 minute'`,
            `UPDATE recurring_invoice SET "dueInDays" = "dueInDays" + 1`,
            `UPDATE invoice SET notes = 'racing edit'`,
          ]) await expect(writer.query(statement, statement.startsWith("INSERT") ? [organizationId] : [])).rejects.toMatchObject({ code: "55P03" })
          checked = true
        }
        return targetClient.query(sql, params)
      } } as unknown as Client
      try {
        expect(await enableOperations({ client, reviewToken: token, jobs: "keep", sourceStopped: true })).toMatchObject({ cutover: "verified" })
        expect(checked).toBe(true)
        // The same write succeeds after commit. It is new live work, outside the reviewed restore.
        await writer.query(`UPDATE recurring_invoice SET "dueInDays" = "dueInDays" + 1`)
      } finally {
        await writer.end()
        await targetClient.query(`UPDATE recovery_state SET "operationsMode" = 'held'`)
      }
    })

    it("resumes work only after the explicit action, and then the queued email goes out", async () => {
      const token = reviewToken(await reviewPendingWork(queryFn(targetClient)))
      const { cancelledJobs } = await enableOperations({ client: targetClient, reviewToken: token, jobs: "keep", sourceStopped: true })
      expect(cancelledJobs).toBe(0)
      const state = await target.recoveryState.findUniqueOrThrow({ where: { id: "default" } })
      expect(state).toMatchObject({ operationsMode: "live", heldReason: null })
      expect(relay.connections()).toBe(0)
      bootstrapQuitsRuntime({ services: { documentArtifactStore: localDiskArtifactStore(targetArtifacts),
        documentRenderer: { version: "must-not-render", renderPdf: async () => { throw new Error("Issued bytes must not be regenerated") } },
      } })
      expect(await runDueJobs({ organizationIds: [organizationId] })).toMatchObject({ succeeded: 1, failed: 0 })
      expect(relay.messages).toHaveLength(1)
      expect(relay.messages[0]).toContain("accounts@acme.invalid")
      const invoice = await target.invoice.findUniqueOrThrow({ where: { id: pendingEmailInvoiceId } })
      expect(invoice).toMatchObject({ status: "sent", artifactPdfRef: pendingArtifacts.pdf.ref, artifactPdfHash: pendingArtifacts.pdf.hash,
        artifactUblRef: pendingArtifacts.ubl!.ref, artifactUblHash: pendingArtifacts.ubl!.hash })
      expect(await target.issuanceCandidate.findFirstOrThrow({ where: { documentId: pendingEmailInvoiceId } })).toMatchObject({ status: "published" })
      const response = await documentPdf("invoice", pendingEmailInvoiceId, organizationId)
      expect(response.status).toBe(200)
      expect(response.headers.get("X-Quits-Artifact")).toBe("stored")
      const published = new Uint8Array(await response.arrayBuffer())
      expect(sha256Bytes(published)).toBe(pendingArtifacts.pdf.hash)
      expect(Buffer.from(published)).toEqual(await readFile(join(sourceArtifacts, pendingArtifacts.pdf.ref)))
      expect(sha256Bytes((await localDiskArtifactStore(targetArtifacts).get(pendingArtifacts.ubl!.ref))!)).toBe(pendingArtifacts.ubl!.hash)
    }, 60_000)
  })

  it("keeps an explicitly incomplete old v1 restore held and refuses ordinary cutover", async () => {
    const schema = `rec_incomplete_${randomUUID().replaceAll("-", "")}`
    await migrate(schema)
    const client = new Client({ connectionString: withSchema(schema) })
    await client.connect()
    try {
      // The old v1 bundle keeps the real candidate, staging and job rows and omits only PDF inventory.
      const copy = join(workspace.dir, "old-v1-pdf")
      const restored = await restoreBundle(options({ client, bundle: copy, allowIncomplete: true,
        artifactStore: localDiskArtifactStore(join(workspace.dir, "incomplete-artifacts")) }))
      expect(restored.gates).toMatchObject({ integrity: "pass", artifacts: "fail", rows: "pass", keys: "pass" })
      expect(restored.warnings.join(" ")).toContain(pendingArtifacts.pdf.ref)
      const token = reviewToken(await reviewPendingWork(queryFn(client)))
      await expect(enableOperations({ client, reviewToken: token, jobs: "keep", sourceStopped: true })).rejects.toMatchObject({
        code: "gates_not_passed", message: expect.stringContaining("artifacts (fail)"),
      })
      expect((await client.query(`SELECT "operationsMode" FROM recovery_state`)).rows[0].operationsMode).toBe("held")
      expect((await client.query(`SELECT status FROM issuance_candidate WHERE "documentId" = $1`, [pendingEmailInvoiceId])).rows[0].status).toBe("bound")
      expect((await client.query(`SELECT count(*)::int AS n FROM job WHERE status = 'pending'`)).rows[0].n).toBeGreaterThan(0)
      expect(relay.messages).toHaveLength(1) // Only the earlier deliberate successful cutover sent.
    } finally {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`)
      await client.end()
    }
  }, 60_000)

  it("cancels queued jobs at cutover when asked", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "quits-recovery-cancel-"))
    const schema = `rec_cancel_${randomUUID().replaceAll("-", "")}`
    await migrate(schema)
    const client = new Client({ connectionString: withSchema(schema) })
    await client.connect()
    try {
      await restoreBundle({ ...options({ client }), artifactStore: localDiskArtifactStore(scratch) })
      const token = reviewToken(await reviewPendingWork(queryFn(client)))
      const { cancelledJobs } = await enableOperations({ client, reviewToken: token, jobs: "cancel", sourceStopped: true })
      expect(cancelledJobs).toBeGreaterThanOrEqual(1)
      expect((await client.query(`SELECT count(*)::int AS n FROM job WHERE status IN ('pending','running')`)).rows[0].n).toBe(0)
    } finally {
      await client.end()
      const admin = new Client({ connectionString: baseUrl })
      await admin.connect()
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      await admin.end()
      await rm(scratch, { recursive: true, force: true })
    }
  }, 60_000)
})
