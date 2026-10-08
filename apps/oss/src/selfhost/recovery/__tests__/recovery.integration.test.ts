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
import { createBackup } from "../backup"
import { verifyBundle } from "../bundle"
import { RecoveryError } from "../../../lib/recovery/format"
import { enableOperations, reviewPendingWork, reviewToken } from "../operations"
import { queryFn } from "../../../lib/recovery/pgdb"
import { preflightRestore, restoreBundle, RestoreBlockedError } from "../restore"
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

/** A mail relay that only counts how many times anything connects to it. */
async function startMailRelay() {
  let connections = 0
  const server = net.createServer((socket) => {
    connections += 1
    socket.write("220 relay ready\r\n")
    socket.on("data", () => socket.write("421 closing\r\n"))
    socket.on("error", () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: (server.address() as net.AddressInfo).port,
    connections: () => connections,
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
    bootstrapQuitsRuntime({ services: { documentRenderer: selfhostDocumentRenderer, documentArtifactStore: localDiskArtifactStore(sourceArtifacts) } })
    const fixture = await seedRehearsalFixture()
    organizationId = fixture.organizationId
    invoiceIds = fixture.invoiceIds
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

    it("does not enable operations after a rehearsal without production keys", async () => {
      const state = await target.recoveryState.findUniqueOrThrow({ where: { id: "default" } })
      await targetClient.query(`UPDATE recovery_state SET "restoreReport" = jsonb_set("restoreReport", '{gates,keys}', '"skipped"')`)
      const token = reviewToken(await reviewPendingWork(queryFn(targetClient)))
      await expect(enableOperations({ client: targetClient, reviewToken: token, jobs: "keep", sourceStopped: true })).rejects.toMatchObject({ code: "gates_not_passed", message: expect.stringContaining("keys (skipped)") })
      await targetClient.query(`UPDATE recovery_state SET "restoreReport" = $1::jsonb`, [JSON.stringify(state.restoreReport)])
    })

    it("resumes work only after the explicit action, and then the queued email goes out", async () => {
      const token = reviewToken(await reviewPendingWork(queryFn(targetClient)))
      const { cancelledJobs } = await enableOperations({ client: targetClient, reviewToken: token, jobs: "keep", sourceStopped: true })
      expect(cancelledJobs).toBe(0)
      const state = await target.recoveryState.findUniqueOrThrow({ where: { id: "default" } })
      expect(state).toMatchObject({ operationsMode: "live", heldReason: null })
      expect(relay.connections()).toBe(0)
      // The relay counts real connections: with operations enabled, the queued email reaches it.
      await runDueJobs({ organizationIds: [organizationId] })
      expect(relay.connections()).toBeGreaterThan(0)
    }, 60_000)
  })

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
