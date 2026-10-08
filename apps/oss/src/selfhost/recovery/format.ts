import { z } from "zod"

/**
 * The backup bundle is a directory:
 *
 *   manifest.json          what the bundle holds, with a SHA-256 for every other file
 *   database/<table>.jsonl one JSON row per line, written by PostgreSQL itself (numbers stay exact)
 *   artifacts/<ref>        issued PDFs and e-invoices, with their `.meta.json`
 *
 * `formatVersion` changes only when a restore of older bundles would need different handling.
 */
export const BACKUP_FORMAT = "quits-backup"
export const BACKUP_FORMAT_VERSION = 1
export const SUPPORTED_FORMAT_VERSIONS: readonly number[] = [1]

export const MANIFEST_FILE = "manifest.json"
export const DATABASE_DIRECTORY = "database"
export const ARTIFACT_DIRECTORY = "artifacts"

/**
 * Tables left out of a bundle. Everything else is backed up, so a new table is covered without
 * touching this list; an excluded table needs a reason a person can read.
 */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  _prisma_migrations: "Migration history is rebuilt by `prisma migrate deploy` on the target.",
  session: "Sign-in sessions are not restored; everyone signs in again.",
  verification: "Pending password-reset and verification tokens expire and are not restored.",
  auth_recovery_rate_limit: "Rate-limit counters are transient.",
  public_link_attempt: "Rate-limit counters for public links are transient.",
  scheduler_scan: "Scheduler claims belong to the source's running processes; they are rebuilt.",
  recovery_state: "Describes this installation's operating state, not its data.",
  backup_record: "History of backups made from the source installation.",
}

/** Columns blanked in a bundle because the application never needs them to resume. */
export const REDACTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  account: ["accessToken", "refreshToken", "idToken"],
}

/** Columns holding values encrypted with a key derived from `BETTER_AUTH_SECRET`. */
export const ENCRYPTED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "org_settings", column: "aiApiKeyEnc" },
  { table: "org_settings", column: "stripeSecretKeyEnc" },
  { table: "org_settings", column: "stripeWebhookSecretEnc" },
]

/** Tables with issued-document references, and the columns holding them. */
export const ARTIFACT_OWNERS: ReadonlyArray<{
  table: string
  documentKind: "invoice" | "creditNote" | "agreement"
  fields: ReadonlyArray<{ ref: string; hash: string; format: "pdf" | "ubl" }>
}> = (
  [
    ["invoice", "invoice"],
    ["credit_note", "creditNote"],
    ["agreement", "agreement"],
  ] as const
).map(([table, documentKind]) => ({
  table,
  documentKind,
  fields: [
    { ref: "artifactPdfRef", hash: "artifactPdfHash", format: "pdf" as const },
    { ref: "artifactUblRef", hash: "artifactUblHash", format: "ubl" as const },
  ],
}))

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const amount = z.string().regex(/^-?\d+(\.\d+)?$/)

const currencyTotals = z.object({
  invoices: z.object({ count: z.number().int(), gross: amount, paid: amount, credited: amount }),
  creditNotes: z.object({ count: z.number().int(), gross: amount }),
  payments: z.object({
    count: z.number().int(),
    amount: amount,
    voidedCount: z.number().int(),
    voidedAmount: amount,
  }),
})

export const manifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.number().int(),
  bundleId: z.string().min(1),
  createdAt: z.string().datetime(),
  source: z.object({
    appVersion: z.string(),
    distribution: z.string(),
    postgresVersion: z.string(),
    /** Applied migrations in order; a restore target must be at or beyond the last one. */
    migrations: z.array(z.string()),
  }),
  database: z.object({
    tables: z.array(
      z.object({
        name: z.string(),
        file: z.string(),
        rows: z.number().int(),
        bytes: z.number().int(),
        sha256,
        columns: z.array(z.string()),
      })
    ),
    excluded: z.array(z.object({ table: z.string(), reason: z.string() })),
    redacted: z.array(z.object({ table: z.string(), columns: z.array(z.string()) })),
  }),
  artifacts: z.object({
    objects: z.array(
      z.object({
        ref: z.string(),
        file: z.string(),
        metaFile: z.string(),
        sha256,
        bytes: z.number().int(),
        owner: z.object({
          table: z.string(),
          id: z.string(),
          organizationId: z.string(),
          field: z.string(),
        }),
      })
    ),
    /** Issued documents whose references were absent or unreadable when the backup ran. */
    missing: z.array(
      z.object({
        table: z.string(),
        id: z.string(),
        field: z.string(),
        ref: z.string().nullable(),
        problem: z.string(),
      })
    ),
  }),
  /** Per currency, so a restore can prove balances without trusting the restored application. */
  totals: z.record(z.string(), currencyTotals),
  keys: z.object({
    /** Truncated HMAC fingerprints, enough to tell whether a key is the same; never the key. */
    fingerprints: z.record(z.string(), z.string().nullable()),
    encryptedValues: z.number().int(),
  }),
  /** Names of settings the installation relied on, and whether each was set. Never values. */
  configuration: z.array(z.object({ name: z.string(), set: z.boolean(), purpose: z.string() })),
  pendingWork: z.object({
    jobsPending: z.number().int(),
    jobsRunning: z.number().int(),
    jobsFailed: z.number().int(),
    jobsByType: z.record(z.string(), z.number().int()),
    remindersDue: z.number().int(),
    recurringDue: z.number().int(),
    eventDeliveriesPending: z.number().int(),
  }),
})

export type Manifest = z.infer<typeof manifestSchema>
export type CurrencyTotals = z.infer<typeof currencyTotals>

export class RecoveryError extends Error {
  override readonly name = "RecoveryError"
  constructor(
    readonly code: string,
    message: string,
    /** What the operator can do about it. */
    readonly action?: string
  ) {
    super(action ? `${message} ${action}` : message)
  }
}

/** Parses a manifest's JSON, with errors that say what is wrong and what to do. */
export function parseManifest(text: string): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new RecoveryError("manifest_unreadable", "manifest.json is not valid JSON.", "The bundle is damaged; use another copy.")
  }
  const header = z.object({ format: z.unknown(), formatVersion: z.unknown() }).safeParse(raw)
  if (!header.success || header.data.format !== BACKUP_FORMAT) {
    throw new RecoveryError(
      "not_a_backup",
      "This directory is not a Quits backup bundle.",
      `Expected a manifest.json with "format": "${BACKUP_FORMAT}".`
    )
  }
  const version = header.data.formatVersion
  if (typeof version !== "number" || !SUPPORTED_FORMAT_VERSIONS.includes(version)) {
    const newer = typeof version === "number" && version > BACKUP_FORMAT_VERSION
    throw new RecoveryError(
      "unsupported_format_version",
      `Backup format version ${String(version)} is not supported (this release reads ${SUPPORTED_FORMAT_VERSIONS.join(", ")}).`,
      newer
        ? "The backup was made by a newer Quits release. Install that release or newer to restore it."
        : "Restore it with the Quits release that made it, then upgrade."
    )
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new RecoveryError(
      "manifest_invalid",
      `manifest.json is incomplete or damaged at ${issue?.path.join(".") || "the top level"}: ${issue?.message ?? "invalid"}.`,
      "Use another copy of the bundle."
    )
  }
  return parsed.data
}
