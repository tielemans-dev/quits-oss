/**
 * Numbers the drafts that have no number, so the change that numbers invoices and quotes when they
 * are issued can be rolled back. Older code requires every invoice and quote to have a number.
 *
 * The caller passes a connected `pg` client. Everything runs in one transaction: it is applied as a
 * whole or not at all. See docs/number-at-issuance-rollback.md.
 */

/** Per kind: the table, and the counter and prefix columns in `org_settings`. */
const KINDS = [
  { kind: "invoice", table: "invoice", prefix: "invoicePrefix", next: "invoiceNextNum" },
  { kind: "quote", table: "quote", prefix: "quotePrefix", next: "quoteNextNum" },
]

/** Same format as `formatDocumentNumber` in apps/oss/src/domain/documents/numbering.ts. */
export function formatDocumentNumber(prefix, value) {
  return `${prefix}-${String(value).padStart(4, "0")}`
}

/**
 * Gives every number-less invoice and quote the next number of its organization, oldest first, then
 * makes the column required again. `dryRun` rolls everything back and only reports the plan.
 *
 * Each organization is handled under the same lock the app takes to issue a document (its
 * `org_settings` row, then the document rows), so the numbers come from the live counters.
 */
export async function prepareNumberRollback(client, { dryRun = false, lockTimeoutMs = 30_000 } = {}) {
  const organizations = []
  await client.query("BEGIN")
  try {
    // Changing the column needs an exclusive lock on the table: fail instead of waiting forever for a running app.
    await client.query(`SET LOCAL lock_timeout = ${Math.trunc(lockTimeoutMs)}`)
    const { rows: pending } = await client.query(
      `SELECT DISTINCT "organizationId" FROM (
         SELECT "organizationId" FROM "invoice" WHERE "number" IS NULL
         UNION ALL
         SELECT "organizationId" FROM "quote" WHERE "number" IS NULL
       ) AS numberless ORDER BY "organizationId"`
    )
    for (const { organizationId } of pending) {
      const locked = await client.query(`SELECT "id" FROM "org_settings" WHERE "organizationId" = $1 FOR UPDATE`, [organizationId])
      if (locked.rowCount === 0) {
        throw new Error(`Organization ${organizationId} has numberless drafts but no settings row to number them from`)
      }
      const report = { organizationId, invoice: [], quote: [] }
      for (const { kind, table, prefix, next } of KINDS) {
        const { rows: drafts } = await client.query(
          `SELECT "id" FROM "${table}" WHERE "organizationId" = $1 AND "number" IS NULL ORDER BY "createdAt", "id" FOR UPDATE`,
          [organizationId]
        )
        for (const { id } of drafts) {
          const { rows } = await client.query(
            `UPDATE "org_settings" SET "${next}" = "${next}" + 1 WHERE "organizationId" = $1 RETURNING "${prefix}" AS prefix, "${next}" AS next`,
            [organizationId]
          )
          const number = formatDocumentNumber(rows[0].prefix, rows[0].next - 1)
          await client.query(`UPDATE "${table}" SET "number" = $1 WHERE "id" = $2`, [number, id])
          report[kind].push({ id, number })
        }
      }
      organizations.push(report)
    }
    for (const { table } of KINDS) {
      await client.query(`ALTER TABLE "${table}" ALTER COLUMN "number" SET NOT NULL`)
    }
    await client.query(dryRun ? "ROLLBACK" : "COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  }
  return {
    dryRun,
    organizations,
    invoices: organizations.reduce((sum, org) => sum + org.invoice.length, 0),
    quotes: organizations.reduce((sum, org) => sum + org.quote.length, 0),
  }
}

/** The database name in a connection URL, or null when it cannot be read. */
export function databaseNameOf(databaseUrl) {
  try {
    return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, "")) || null
  } catch {
    return null
  }
}
