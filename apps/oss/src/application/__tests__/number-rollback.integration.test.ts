import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import pg from "pg"
import { prisma } from "../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../test-utils/organization"
import { createInvoiceDraft } from "../../domain/commands/invoices"
import { createQuoteDraft } from "../../domain/commands/quotes"
import { executeCommand } from "../../domain/execute"
import { formatDocumentNumber } from "../../domain/documents/numbering"
// @ts-expect-error The script library is plain JavaScript and has no type declarations.
import * as rollback from "../../../../../scripts/number-rollback-lib.mjs"

const { prepareNumberRollback, databaseNameOf } = rollback as {
  prepareNumberRollback: (client: pg.Client, options?: { dryRun?: boolean; lockTimeoutMs?: number }) => Promise<{
    dryRun: boolean; invoices: number; quotes: number
    organizations: Array<{ organizationId: string; invoice: Array<{ id: string; number: string }>; quote: Array<{ id: string; number: string }> }>
  }>
  databaseNameOf: (url: string) => string | null
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

/**
 * The script changes the table definition, which the shared test database must keep as it is. The
 * script therefore runs against copies of the three tables it touches, in a schema of their own.
 */
async function scratchSchema() {
  const schema = `rollback_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  await client.query(`CREATE SCHEMA ${schema}`)
  for (const table of ["org_settings", "invoice", "quote"]) {
    await client.query(`CREATE TABLE ${schema}."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`)
  }
  await client.query(`SET search_path TO ${schema}`)
  cleanups.push(async () => {
    await client.query("SET search_path TO public").catch(() => undefined)
    await client.query(`DROP SCHEMA ${schema} CASCADE`)
    await client.end()
  })
  const copyOrganization = async (organizationId: string) => {
    for (const table of ["org_settings", "invoice", "quote"]) {
      await client.query(`INSERT INTO ${schema}."${table}" SELECT * FROM public."${table}" WHERE "organizationId" = $1`, [organizationId])
    }
  }
  return { client, schema, copyOrganization }
}

;(hasTestDatabase ? describe : describe.skip)("preparing the database to roll back numbering at issuance", () => {
  async function organization(settings: { invoicePrefix: string; invoiceNextNum: number; quotePrefix: string; quoteNextNum: number }) {
    const org = await createTestOrganization()
    cleanups.push(org.cleanup)
    await prisma.orgSettings.update({ where: { organizationId: org.organizationId }, data: settings })
    const contact = await prisma.contact.create({ data: { organizationId: org.organizationId, name: "Customer", email: "customer@example.test" } })
    const input = { dueDate: "2099-01-01", taxRate: 0, items: [{ description: "Work", quantity: 1, unitPrice: 100 }] }
    const invoice = async () => {
      const created = await executeCommand(createInvoiceDraft, { contactId: contact.id, ...input }, { actor: org.actors.admin })
      if (created.status !== "completed") throw new Error(JSON.stringify(created))
      return created.result.id
    }
    const quote = async () => {
      const created = await executeCommand(createQuoteDraft, { contactId: contact.id, expiryDate: "2099-01-01", taxRate: 0, items: input.items }, { actor: org.actors.admin })
      if (created.status !== "completed") throw new Error(JSON.stringify(created))
      return created.result.id
    }
    return { org, invoice, quote }
  }

  it("numbers numberless drafts per organization, oldest first, from the live counters, and requires the number again", async () => {
    const a = await organization({ invoicePrefix: "FAK", invoiceNextNum: 42, quotePrefix: "TIL", quoteNextNum: 7 })
    const b = await organization({ invoicePrefix: "INV", invoiceNextNum: 1, quotePrefix: "QTE", quoteNextNum: 1 })
    const legacy = await a.invoice()
    await prisma.invoice.update({ where: { id: legacy }, data: { number: "FAK-0041" } })
    const first = await a.invoice()
    const second = await a.invoice()
    const quoteA = await a.quote()
    const invoiceB = await b.invoice()
    // Creation order decides the numbers, not the order of the ids.
    await prisma.invoice.update({ where: { id: first }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } })
    await prisma.invoice.update({ where: { id: second }, data: { createdAt: new Date("2026-01-02T00:00:00Z") } })

    const { client, copyOrganization } = await scratchSchema()
    await copyOrganization(a.org.organizationId)
    await copyOrganization(b.org.organizationId)
    const result = await prepareNumberRollback(client)

    const numbers = async (table: string) => Object.fromEntries((await client.query(`SELECT "id", "number" FROM "${table}"`)).rows.map(row => [row.id, row.number]))
    expect(await numbers("invoice")).toEqual({ [legacy]: "FAK-0041", [first]: "FAK-0042", [second]: "FAK-0043", [invoiceB]: "INV-0001" })
    expect(await numbers("quote")).toEqual({ [quoteA]: "TIL-0007" })
    expect(result).toMatchObject({ dryRun: false, invoices: 3, quotes: 1 })
    const counters = (await client.query(`SELECT "organizationId", "invoiceNextNum", "quoteNextNum" FROM "org_settings"`)).rows
    expect(counters.find(row => row.organizationId === a.org.organizationId)).toMatchObject({ invoiceNextNum: 44, quoteNextNum: 8 })
    expect(counters.find(row => row.organizationId === b.org.organizationId)).toMatchObject({ invoiceNextNum: 2, quoteNextNum: 1 })

    // The numbers are the ones the app itself would have given, in the same format.
    expect(formatDocumentNumber("FAK", 42)).toBe("FAK-0042")
    // Both columns are required again, which is what the previous release expects.
    const nullable = await client.query(`SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'number' AND table_name IN ('invoice', 'quote')`)
    expect(nullable.rows.map(row => row.is_nullable)).toEqual(["NO", "NO"])
    await expect(client.query(`UPDATE "invoice" SET "number" = NULL WHERE "id" = $1`, [legacy])).rejects.toThrow(/null value/)
  })

  it("only reports on a dry run and leaves the database as it was", async () => {
    const a = await organization({ invoicePrefix: "INV", invoiceNextNum: 5, quotePrefix: "QTE", quoteNextNum: 1 })
    const draft = await a.invoice()
    const { client, copyOrganization } = await scratchSchema()
    await copyOrganization(a.org.organizationId)
    const result = await prepareNumberRollback(client, { dryRun: true })
    expect(result).toMatchObject({ dryRun: true, invoices: 1, organizations: [{ invoice: [{ id: draft, number: "INV-0005" }] }] })
    expect((await client.query(`SELECT "number" FROM "invoice" WHERE "id" = $1`, [draft])).rows[0].number).toBeNull()
    expect((await client.query(`SELECT "invoiceNextNum" FROM "org_settings" WHERE "organizationId" = $1`, [a.org.organizationId])).rows[0].invoiceNextNum).toBe(5)
    const nullable = await client.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'invoice' AND column_name = 'number'`)
    expect(nullable.rows[0].is_nullable).toBe("YES")
  })

  it("changes nothing when it fails part way, and does nothing twice", async () => {
    const a = await organization({ invoicePrefix: "INV", invoiceNextNum: 1, quotePrefix: "QTE", quoteNextNum: 1 })
    const draft = await a.invoice()
    const { client, copyOrganization } = await scratchSchema()
    await copyOrganization(a.org.organizationId)
    // An organization with drafts but without its settings cannot be numbered.
    await client.query(`DELETE FROM "org_settings" WHERE "organizationId" = $1`, [a.org.organizationId])
    await expect(prepareNumberRollback(client)).rejects.toThrow(/no settings row/)
    expect((await client.query(`SELECT "number" FROM "invoice" WHERE "id" = $1`, [draft])).rows[0].number).toBeNull()

    // With its settings back, the same drafts can be numbered.
    await client.query(`INSERT INTO "org_settings" SELECT * FROM public."org_settings" WHERE "organizationId" = $1`, [a.org.organizationId])
    expect(await prepareNumberRollback(client)).toMatchObject({ invoices: 1 })
    expect(await prepareNumberRollback(client)).toMatchObject({ invoices: 0, quotes: 0, organizations: [] })
  })

  it("reads the database name from a connection URL", () => {
    expect(databaseNameOf("postgresql://user:secret@127.0.0.1:5432/yaip?schema=public")).toBe("yaip")
    expect(databaseNameOf("not a url")).toBeNull()
  })
})
