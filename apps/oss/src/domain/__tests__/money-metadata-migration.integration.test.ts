import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "pg"
import { describe, expect, it } from "vitest"
import { hasTestDatabase } from "../../test-utils/organization"

const target = "20261007170000_ledger_money_metadata"
const parents = ["invoice", "quote", "credit_note", "agreement"]
const children = ["invoice_item", "quote_item", "credit_note_item", "deliverable"]
const foreignKeys = ["invoiceId", "quoteId", "creditNoteId", "agreementId"]

describe.runIf(hasTestDatabase)("additive money metadata migration", () => {
  it("backfills populated inclusive/exclusive and zero/standard rows, preserving all existing columns and legacy writer defaults", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const schema = `money_a2a1_${randomUUID().replaceAll("-", "")}`
    const migrations = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url))
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      for (const name of (await readdir(migrations)).filter((name) => /^\d/.test(name) && name < target).sort())
        await client.query((await readFile(path.join(migrations, name, "migration.sql"), "utf8")).replaceAll('"public".', `"${schema}".`))
      await client.query(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ('org','Existing','existing',now());
        INSERT INTO contact (id,"organizationId",name,"updatedAt") VALUES ('buyer','org','Buyer',now());`)
      async function seed(suffix: string, inclusive: boolean) {
        await client.query(`INSERT INTO invoice (id,"organizationId","contactId",number,"dueDate","subtotalNet","totalGross",currency,"pricesIncludeTax","updatedAt") VALUES ('i${suffix}','org','buyer','I${suffix}',now(),100,125,'KWD',${inclusive},now());
          INSERT INTO quote (id,"organizationId","contactId",number,"expiryDate","subtotalNet","totalGross","pricesIncludeTax","updatedAt") VALUES ('q${suffix}','org','buyer','Q${suffix}',now(),100,125,${inclusive},now());
          INSERT INTO credit_note (id,"organizationId","invoiceId","contactId",number,reason,"subtotalNet","totalGross",currency,"countryCode",locale,timezone,"taxRegime","pricesIncludeTax","updatedAt") VALUES ('c${suffix}','org','i${suffix}','buyer','C${suffix}','Return',100,125,'EUR','DK','da-DK','UTC','eu_vat',${inclusive},now());
          INSERT INTO agreement (id,"organizationId","contactId",title,"termsMarkdown","validUntil","subtotalNet","totalGross","pricesIncludeTax","offerSnapshot","offerSnapshotHash","updatedAt") VALUES ('a${suffix}','org','buyer','Offer','Terms',now(),100,125,${inclusive},'{"legacy":true,"decimal":"100.00"}','pinned-historical-hash',now());`)
        for (const [index, table] of children.entries()) {
          for (const rate of ["25", "0"]) {
            const parentId = `${["i", "q", "c", "a"][index]}${suffix}`
            await client.query(`INSERT INTO "${table}" (id,"${foreignKeys[index]}",${table === "deliverable" ? 'title,' : ''}description,quantity,"unitPriceNet","unitPriceGross","lineNet","lineGross","taxRate") VALUES ($1,$2,${table === "deliverable" ? "'Work'," : ''}'Work',0.5,100,125,50,62.5,$3)`, [`${table}${suffix}${rate}`, parentId, rate])
          }
        }
      }
      await seed("exclusive", false)
      await seed("inclusive", true)
      const before = new Map<string, Record<string, unknown>[]>()
      for (const table of [...parents, ...children]) before.set(table, (await client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows)
      await client.query(await readFile(path.join(migrations, target, "migration.sql"), "utf8"))
      for (const table of parents) {
        const after = (await client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows
        expect(after).toEqual(before.get(table)!.map((row) => ({ ...row, calculationVersion: "legacy_per_line", vatEvidence: null })))
      }
      for (const table of children) {
        const after = (await client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows
        expect(after).toEqual(before.get(table)!.map((row) => ({
          ...row, vatTreatment: Number(row.taxRate) > 0 ? "standard" : "unclassified_zero",
          vatCountry: null, vatReasonCode: null, quantityInput: "0.50",
          unitPriceInput: String(row.id).includes("inclusive") ? "125.00" : "100.00", inputPrecision: "backfilled",
        })))
      }
      await seed("new", false)
      for (const table of parents)
        expect((await client.query(`SELECT "calculationVersion", "vatEvidence" FROM "${table}" WHERE id LIKE '%new'`)).rows).toEqual([{ calculationVersion: "legacy_per_line", vatEvidence: null }])
      for (const table of children)
        expect((await client.query(`SELECT "vatTreatment","quantityInput","unitPriceInput","inputPrecision" FROM "${table}" WHERE id LIKE '%new%'`)).rows).toEqual(Array(2).fill({ vatTreatment: "standard", quantityInput: null, unitPriceInput: null, inputPrecision: null }))
    } finally {
      await client.query("SET search_path TO public")
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await client.end()
    }
  })
})
