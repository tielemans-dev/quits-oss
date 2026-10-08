import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { sha256Bytes, verifyBundle } from "../bundle"
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, parseManifest, RecoveryError, type Manifest } from "../../../lib/recovery/format"
import { compareKeys, keyFingerprints } from "../keys"
import { diffTotals } from "../restore"

const directories: string[] = []
afterEach(async () => {
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true })
})

function manifestFor(overrides: Partial<Manifest> = {}): Manifest {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    bundleId: "bundle-1",
    createdAt: "2026-10-08T10:00:00.000Z",
    source: { appVersion: "0.5.0", distribution: "selfhost", postgresVersion: "16.4", migrations: ["20261010000000_recovery_state"] },
    database: { tables: [], excluded: [], redacted: [] },
    artifacts: { objects: [], missing: [] },
    totals: {},
    keys: { fingerprints: {}, encryptedValues: 0 },
    configuration: [],
    pendingWork: { jobsPending: 0, jobsRunning: 0, jobsFailed: 0, jobsByType: {}, remindersDue: 0, recurringDue: 0, eventDeliveriesPending: 0 },
    ...overrides,
  }
}

async function writeBundle(manifest: Manifest, files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "quits-bundle-test-"))
  directories.push(directory)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(directory, name, ".."), { recursive: true })
    await writeFile(join(directory, name), content)
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest))
  return directory
}

const row = `{"id":"a"}\n`
const tableEntry = (content = row) => ({
  name: "contact",
  file: "database/contact.jsonl",
  rows: 1,
  bytes: Buffer.byteLength(content),
  sha256: sha256Bytes(content),
  columns: ["id"],
})

describe("parseManifest", () => {
  it("rejects a directory that is not a Quits backup", () => {
    expect(() => parseManifest(JSON.stringify({ format: "other" }))).toThrow(/not a Quits backup/)
  })

  it("explains an unsupported newer format version and what to do", () => {
    const text = JSON.stringify({ ...manifestFor(), formatVersion: 99 })
    expect(() => parseManifest(text)).toThrow(RecoveryError)
    expect(() => parseManifest(text)).toThrow(/version 99 is not supported.*newer Quits release/s)
  })

  it("reports a damaged manifest at the offending field", () => {
    const text = JSON.stringify({ ...manifestFor(), source: { appVersion: 1 } })
    expect(() => parseManifest(text)).toThrow(/damaged at source/)
  })
})

describe("verifyBundle", () => {
  it("accepts an intact bundle and reports the manifest digest", async () => {
    const directory = await writeBundle(manifestFor({ database: { tables: [tableEntry()], excluded: [], redacted: [] } }), { "database/contact.jsonl": row })
    const check = await verifyBundle(directory)
    expect(check.findings).toEqual([])
    expect(check.filesChecked).toBe(1)
    expect(check.manifestSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("detects a changed database file", async () => {
    const directory = await writeBundle(manifestFor({ database: { tables: [tableEntry()], excluded: [], redacted: [] } }), { "database/contact.jsonl": `{"id":"b"}\n` })
    const check = await verifyBundle(directory)
    expect(check.findings).toMatchObject([{ severity: "error", code: "integrity_mismatch" }])
  })

  it("detects a truncated file by size before hashing", async () => {
    const directory = await writeBundle(manifestFor({ database: { tables: [tableEntry()], excluded: [], redacted: [] } }), { "database/contact.jsonl": "{" })
    expect((await verifyBundle(directory)).findings).toMatchObject([{ code: "size_mismatch" }])
  })

  it("names an artifact missing from the bundle", async () => {
    const bytes = "%PDF-1.4 issued"
    const object = {
      ref: "org/invoice/inv/abc.pdf",
      file: "artifacts/org/invoice/inv/abc.pdf",
      metaFile: "artifacts/org/invoice/inv/abc.pdf.meta.json",
      sha256: sha256Bytes(bytes),
      bytes: bytes.length,
      owner: { table: "invoice", id: "inv", organizationId: "org", field: "artifactPdfRef" },
    }
    const directory = await writeBundle(manifestFor({ artifacts: { objects: [object], missing: [] } }), {})
    const check = await verifyBundle(directory)
    expect(check.findings.map((finding) => finding.code)).toContain("artifact_object_missing")
    expect(check.findings.find((finding) => finding.code === "artifact_object_missing")?.message).toContain("abc.pdf")
  })

  it("verifies an artifact and its metadata", async () => {
    const bytes = "%PDF-1.4 issued"
    const object = {
      ref: "org/invoice/inv/abc.pdf",
      file: "artifacts/org/invoice/inv/abc.pdf",
      metaFile: "artifacts/org/invoice/inv/abc.pdf.meta.json",
      sha256: sha256Bytes(bytes),
      bytes: bytes.length,
      owner: { table: "invoice", id: "inv", organizationId: "org", field: "artifactPdfRef" },
    }
    const directory = await writeBundle(manifestFor({ artifacts: { objects: [object], missing: [] } }), {
      [object.file]: bytes,
      [object.metaFile]: JSON.stringify({ hash: object.sha256, size: object.bytes }),
    })
    expect((await verifyBundle(directory)).findings).toEqual([])
  })

  it("carries a gap recorded at backup time into the findings", async () => {
    const directory = await writeBundle(
      manifestFor({ artifacts: { objects: [], missing: [{ table: "invoice", id: "inv-1", field: "artifactPdfRef", ref: "x/y.pdf", problem: "object_missing" }] } }),
      {}
    )
    expect((await verifyBundle(directory)).findings).toMatchObject([{ severity: "error", code: "backup_object_missing" }])
  })

  it("does not follow a manifest path out of the bundle", async () => {
    const entry = { ...tableEntry(), file: "../../etc/passwd" }
    const directory = await writeBundle(manifestFor({ database: { tables: [entry], excluded: [], redacted: [] } }), {})
    expect((await verifyBundle(directory)).findings).toMatchObject([{ code: "unsafe_path" }])
  })

  it("asks for the bundle directory when there is no manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quits-bundle-test-"))
    directories.push(directory)
    await expect(verifyBundle(directory)).rejects.toThrow(/No manifest\.json/)
  })
})

describe("keys", () => {
  const source = { BETTER_AUTH_SECRET: "a-source-secret-of-sufficient-length" }

  it("fingerprints differ per key and never contain the key", () => {
    const fingerprints = keyFingerprints(source)
    expect(fingerprints.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(fingerprints)).not.toContain("source-secret")
    expect(keyFingerprints({ BETTER_AUTH_SECRET: "another-secret-of-sufficient-length" }).BETTER_AUTH_SECRET).not.toBe(fingerprints.BETTER_AUTH_SECRET)
  })

  it("follows the application's fallback from public link secrets to the auth secret", () => {
    const fingerprints = keyFingerprints(source)
    expect(fingerprints.PUBLIC_PAYMENT_SECRET).toBe(keyFingerprints({ ...source, QUITS_PUBLIC_PAYMENT_SECRET: source.BETTER_AUTH_SECRET }).PUBLIC_PAYMENT_SECRET)
  })

  it("reports a missing and a different key with the variable to set", () => {
    const recorded = keyFingerprints({ ...source, QUITS_PUBLIC_QUOTE_SECRET: "a-separate-quote-secret-value" })
    const findings = compareKeys(recorded, { BETTER_AUTH_SECRET: "a-different-secret-of-sufficient-length" })
    expect(findings.map((finding) => [finding.code, finding.key])).toEqual(
      expect.arrayContaining([["wrong_key", "BETTER_AUTH_SECRET"], ["wrong_key", "PUBLIC_QUOTE_SECRET"]])
    )
    expect(compareKeys(recorded, {})[0]).toMatchObject({ code: "missing_key", action: expect.stringContaining("BETTER_AUTH_SECRET") })
    expect(compareKeys(recorded, { ...source, QUITS_PUBLIC_QUOTE_SECRET: "a-separate-quote-secret-value" })).toEqual([])
  })
})

describe("diffTotals", () => {
  const totals = {
    USD: {
      invoices: { count: 2, gross: "500.00", paid: "100.00", credited: "0.00" },
      creditNotes: { count: 0, gross: "0" },
      payments: { count: 1, amount: "100.00", voidedCount: 0, voidedAmount: "0" },
    },
  }

  it("is empty for identical totals", () => {
    expect(diffTotals(totals, structuredClone(totals))).toEqual([])
  })

  it("names the currency and the figure that differs", () => {
    const changed = structuredClone(totals)
    changed.USD.payments.amount = "100.01"
    expect(diffTotals(totals, changed)).toEqual(["USD payments.amount: backup 100.00, restored 100.01"])
  })

  it("reports a currency that did not come back", () => {
    expect(diffTotals(totals, {})).toEqual(["USD: missing from the restored database"])
  })
})
