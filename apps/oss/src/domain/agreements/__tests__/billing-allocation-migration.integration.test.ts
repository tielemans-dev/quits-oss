import { describe, expect, it } from "vitest"
import { Client } from "pg"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { hasTestDatabase } from "../../../test-utils/organization"

describe.runIf(hasTestDatabase)("billable allocation identity migration", () => {
  it("backfills source identity for issued lines and keeps one active allocation per source", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const schema = `allocation_migration_${randomUUID().replaceAll("-", "")}`
    const root = fileURLToPath(new URL("../../../../prisma/migrations/", import.meta.url))
    const current = "20261010000000_billable_allocation_identity"
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET search_path TO "${schema}"`)
      for (const name of (await readdir(root)).filter(name => /^\d/.test(name) && name < current).sort())
        await client.query((await readFile(path.join(root, name, "migration.sql"), "utf8")).replaceAll('"public".', `"${schema}".`))
      await client.query(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ('org','Existing','existing',now());
        INSERT INTO contact (id,"organizationId",name,"updatedAt") VALUES ('contact','org','Buyer',now());
        INSERT INTO agreement (id,"organizationId","contactId",title,"termsMarkdown","validUntil","subtotalNet","totalGross","offerSnapshot","offerSnapshotHash","updatedAt") VALUES ('agreement','org','contact','Offer','','2099-01-01',100,100,'{}','hash',now());
        INSERT INTO deliverable (id,"agreementId",title,description,quantity,"unitPriceNet","unitPriceGross","lineNet","lineGross","taxRate","deliveryRevision","billingStatus") VALUES ('line','agreement','Work','Work',1,100,100,100,100,0,3,'invoiced');
        INSERT INTO invoice (id,"organizationId","contactId","agreementId",number,status,"dueDate","subtotalNet","totalGross","updatedAt") VALUES ('invoice','org','contact','agreement','INV-0001','sent',now(),100,100,now());
        INSERT INTO invoice_item (id,"invoiceId","deliverableId",description,quantity,"unitPriceNet","unitPriceGross","lineNet","lineGross","taxRate") VALUES ('item','invoice','line','Work',1,100,100,100,100,0);
        INSERT INTO invoice_item (id,"invoiceId",description,quantity,"unitPriceNet","unitPriceGross","lineNet","lineGross","taxRate") VALUES ('manual','invoice','Manual',1,10,10,10,10,0);`)
      // Work was billed at revision 3, then redelivered before this migration exists.
      await client.query(`UPDATE deliverable SET "deliveryRevision" = 7 WHERE id = 'line'`)
      await client.query(await readFile(path.join(root, current, "migration.sql"), "utf8"))
      expect((await client.query('SELECT id,"sourceKind","sourceId","sourceRevision","allocationGeneration" FROM invoice_item ORDER BY id')).rows).toEqual([
        { id: "item", sourceKind: "deliverable", sourceId: "line", sourceRevision: null, allocationGeneration: 0 },
        { id: "manual", sourceKind: null, sourceId: null, sourceRevision: null, allocationGeneration: 0 },
      ])
      expect((await client.query('SELECT "billingStatus","billingGeneration" FROM deliverable')).rows).toEqual([{ billingStatus: "invoiced", billingGeneration: 0 }])
      const insert = (id: string, generation: number) => client.query(`INSERT INTO invoice_item (id,"invoiceId","deliverableId","allocationGeneration",description,quantity,"unitPriceNet","unitPriceGross","lineNet","lineGross","taxRate") VALUES ($1,'invoice','line',$2,'Work',1,100,100,100,100,0)`, [id, generation])
      await expect(insert("duplicate", 0)).rejects.toMatchObject({ code: "23505" })
      await insert("next-generation", 1)
      // Apply the additive follow-up after a genuine post-migration allocation. Its revision
      // is known and must survive upgrades; only pre-identity rows remain unknown.
      await client.query(`UPDATE invoice_item SET "sourceKind" = 'deliverable', "sourceId" = 'line', "sourceRevision" = '7' WHERE id = 'next-generation'`)
      await client.query(await readFile(path.join(root, "20261010010000_billable_rebill_credit_evidence", "migration.sql"), "utf8"))
      expect((await client.query(`SELECT id,"sourceRevision" FROM invoice_item WHERE "deliverableId" = 'line' ORDER BY id`)).rows).toEqual([
        { id: "item", sourceRevision: null }, { id: "next-generation", sourceRevision: "7" },
      ])
      // Manual lines carry no source and never collide with each other.
      await client.query(`INSERT INTO invoice_item (id,"invoiceId",description,quantity,"unitPriceNet","unitPriceGross","lineNet","lineGross","taxRate") VALUES ('manual-2','invoice','Manual',1,10,10,10,10,0)`)
    } finally { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end() }
  })
})
