import { describe, expect, it } from "vitest"
import { Client } from "pg"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { hasTestDatabase } from "../../../test-utils/organization"

describe.runIf(hasTestDatabase)("agreement billing additive migration", () => {
  it("preserves existing invoices and v1 JSON bytes, defaults purpose to sale, and enforces unique links", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const schema = `agr2_migration_${randomUUID().replaceAll("-", "")}`
    const root = fileURLToPath(new URL("../../../../prisma/migrations/", import.meta.url))
    const current = "20261007190000_agreements_phase2"
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET search_path TO "${schema}"`)
      for (const name of (await readdir(root)).filter(name => /^\d/.test(name) && name < current).sort())
        await client.query((await readFile(path.join(root, name, "migration.sql"), "utf8")).replaceAll('"public".', `"${schema}".`))
      await client.query(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ('org','Existing','existing',now());
        INSERT INTO contact (id,"organizationId",name,"updatedAt") VALUES ('contact','org','Buyer',now());
        INSERT INTO invoice (id,"organizationId","contactId",number,"dueDate","subtotalNet","totalGross","updatedAt") VALUES ('invoice','org','contact','INV-0001',now(),100,100,now());
        INSERT INTO agreement (id,"organizationId","contactId",title,"termsMarkdown","validUntil","subtotalNet","totalGross","offerSnapshot","offerSnapshotHash","updatedAt") VALUES ('agreement','org','contact','Offer','','2099-01-01',100,100,'{"totalGross":"100.00","deposit":true}','v1-frozen-hash',now());
        INSERT INTO deliverable (id,"agreementId",title,description,quantity,"unitPriceNet","unitPriceGross","lineNet","lineGross","taxRate") VALUES ('line','agreement','Work','Work',1,100,100,100,100,0);`)
      const before = (await client.query('SELECT "offerSnapshot"::text AS bytes,"offerSnapshotHash" FROM agreement')).rows[0]
      await client.query(await readFile(path.join(root, current, "migration.sql"), "utf8"))
      expect((await client.query('SELECT "offerSnapshot"::text AS bytes,"offerSnapshotHash" FROM agreement')).rows[0]).toEqual(before)
      expect((await client.query('SELECT "offerFormatVersion" FROM agreement')).rows[0]).toEqual({ offerFormatVersion: null })
      expect((await client.query('SELECT purpose,number,"totalGross","agreementId" FROM invoice')).rows[0]).toEqual({ purpose: "sale", number: "INV-0001", totalGross: "100.00", agreementId: null })
      const sql = `INSERT INTO invoice_item (id,"invoiceId","deliverableId",description,quantity,"unitPriceNet","unitPriceGross","lineNet","lineGross","taxRate") VALUES ($1,'invoice','line','Work',1,100,100,100,100,0)`
      await client.query(sql, ["item-a"])
      await expect(client.query(sql, ["item-b"])).rejects.toMatchObject({ code: "23505" })
    } finally { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end() }
  })
})
