import { describe, expect, it } from "vitest"
import { Client } from "pg"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { hasTestDatabase } from "../../../test-utils/organization"

describe.runIf(hasTestDatabase)("agreement foundation migration", () => {
  it("applies after all previous migrations with existing documents and counters untouched", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const schema = `agreements_migration_${randomUUID().replaceAll("-", "")}`
    const migrations = fileURLToPath(new URL("../../../../prisma/migrations/", import.meta.url))
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      const names = (await readdir(migrations)).filter((name) => /^\d/.test(name)).sort()
      const foundation = "20261007120000_agreement_foundation"
      for (const name of names.filter((name) => name < foundation)) {
        // Legacy migrations qualify public explicitly; keep them inside this throwaway schema.
        const sql = await readFile(path.join(migrations, name, "migration.sql"), "utf8")
        await client.query(sql.replaceAll('"public".', `"${schema}".`))
      }
      await client.query(`INSERT INTO "organization" (id,name,slug,"createdAt") VALUES ('org','Existing','existing',now());
        INSERT INTO "org_settings" (id,"organizationId","invoicePrefix","invoiceNextNum","quotePrefix","quoteNextNum","creditNotePrefix","creditNoteNextNum","updatedAt") VALUES ('settings','org','OLDINV',42,'OLDQTE',17,'OLDCN',9,now());
        INSERT INTO "contact" (id,"organizationId",name,"updatedAt") VALUES ('contact','org','Existing buyer',now());
        INSERT INTO "invoice" (id,"organizationId","contactId",number,"dueDate","subtotalNet","totalGross","updatedAt") VALUES ('invoice','org','contact','OLDINV-0041',now(),100,100,now());
        INSERT INTO "quote" (id,"organizationId","contactId",number,"expiryDate","subtotalNet","totalGross","updatedAt") VALUES ('quote','org','contact','OLDQTE-0016',now(),100,100,now());
        INSERT INTO "credit_note" (id,"organizationId","invoiceId","contactId",number,reason,"subtotalNet","totalGross",currency,"countryCode",locale,timezone,"taxRegime","updatedAt") VALUES ('credit','org','invoice','contact','OLDCN-0008','Correction',10,10,'USD','US','en-US','UTC','us_sales_tax',now());`)
      const settingsBefore = (await client.query('SELECT * FROM "org_settings"')).rows[0]
      const documentsBefore = (
        await client.query(
          'SELECT number FROM "invoice" UNION ALL SELECT number FROM "quote" UNION ALL SELECT number FROM "credit_note"',
        )
      ).rows
      await client.query(await readFile(path.join(migrations, foundation, "migration.sql"), "utf8"))
      const after = (await client.query('SELECT * FROM "org_settings"')).rows[0]
      expect(after).toMatchObject(settingsBefore)
      expect(after).toMatchObject({ agreementPrefix: "AGR", agreementNextNum: 1 })
      expect(
        (
          await client.query(
            'SELECT number FROM "invoice" UNION ALL SELECT number FROM "quote" UNION ALL SELECT number FROM "credit_note"',
          )
        ).rows,
      ).toEqual(documentsBefore)
      await client.query(
        `INSERT INTO "agreement" (id,"organizationId","contactId",title,"termsMarkdown","validUntil","subtotalNet","totalGross","updatedAt") VALUES ('a','org','contact','Draft','','2099-12-01',0,0,now()), ('b','org','contact','Another draft','','2099-12-01',0,0,now());`,
      )
      expect(
        (
          await client.query(
            'SELECT number,"issueDate","expiresAt","offerSnapshot","offerSnapshotHash","issuedToEmail","issuedVia","publicAccessIssuedAt" FROM "agreement"',
          )
        ).rows,
      ).toEqual(
        Array(2).fill({
          number: null,
          issueDate: null,
          expiresAt: null,
          offerSnapshot: null,
          offerSnapshotHash: null,
          issuedToEmail: null,
          issuedVia: null,
          publicAccessIssuedAt: null,
        }),
      )
      await client.query(`UPDATE "agreement" SET number='AGR-0001' WHERE id='a'`)
      await expect(
        client.query(`UPDATE "agreement" SET number='AGR-0001' WHERE id='b'`),
      ).rejects.toMatchObject({ code: "23505" })
      await expect(client.query(`DELETE FROM "contact" WHERE id='contact'`)).rejects.toMatchObject({
        code: "23503",
      })
    } finally {
      await client.query("SET search_path TO public")
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await client.end()
    }
  })
})
