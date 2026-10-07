import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "pg"
import { describe, expect, it } from "vitest"
import { hasTestDatabase } from "../../../test-utils/organization"

describe.runIf(hasTestDatabase)("Phase 4 additive migration", () => {
  it("preserves existing agreements and templates, backfills seeding and enforces unique quote provenance", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const schema = `agreements_phase4_${randomUUID().replaceAll("-", "")}`
    const migrations = fileURLToPath(
      new URL("../../../../prisma/migrations/", import.meta.url),
    )
    const phase4 = "20261007210000_agreement_quote_conversion"
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      const names = (await readdir(migrations))
        .filter((name) => /^\d/.test(name))
        .sort()
      for (const name of names.filter((name) => name < phase4)) {
        const sql = await readFile(
          path.join(migrations, name, "migration.sql"),
          "utf8",
        )
        await client.query(sql.replaceAll('"public".', `"${schema}".`))
      }
      await client.query(`
        INSERT INTO "organization" (id,name,slug,"createdAt") VALUES ('org','Existing','existing',now()), ('new','Unopened','unopened',now());
        INSERT INTO "org_settings" (id,"organizationId","invoiceNextNum","quoteNextNum","agreementNextNum","updatedAt") VALUES ('settings','org',42,17,9,now());
        INSERT INTO "contact" (id,"organizationId",name,"updatedAt") VALUES ('contact','org','Buyer',now());
        INSERT INTO "quote" (id,"organizationId","contactId",number,"expiryDate","subtotalNet","totalGross","updatedAt") VALUES ('quote','org','contact','QTE-0016',now(),100,100,now());
        INSERT INTO "agreement_template" (id,"organizationId",name,"termsMarkdown","isDefault","updatedAt") VALUES ('template','org','Edited template','Edited terms',true,now());
        INSERT INTO "agreement" (id,"organizationId","contactId",title,"termsMarkdown","templateId","validUntil","subtotalNet","totalGross","updatedAt") VALUES ('agreement','org','contact','Existing draft','Independent terms','template','2099-12-01',100,100,now());
      `)
      const before = (await client.query('SELECT * FROM "agreement"')).rows[0]
      const counters = (await client.query('SELECT * FROM "org_settings"'))
        .rows[0]
      await client.query(
        await readFile(path.join(migrations, phase4, "migration.sql"), "utf8"),
      )
      expect((await client.query('SELECT * FROM "agreement"')).rows[0]).toEqual(
        { ...before, sourceQuoteId: null },
      )
      expect(
        (await client.query('SELECT * FROM "org_settings"')).rows[0],
      ).toEqual(counters)
      expect(
        (
          await client.query(
            'SELECT id,"agreementTemplatesSeeded" FROM "organization" ORDER BY id',
          )
        ).rows,
      ).toEqual([
        { id: "new", agreementTemplatesSeeded: false },
        { id: "org", agreementTemplatesSeeded: true },
      ])
      await client.query(
        `UPDATE "agreement" SET "sourceQuoteId"='quote' WHERE id='agreement'`,
      )
      await expect(
        client.query(
          `INSERT INTO "agreement" (id,"organizationId","contactId",title,"termsMarkdown","validUntil","subtotalNet","totalGross","sourceQuoteId","updatedAt") VALUES ('duplicate','org','contact','Duplicate','','2099-12-01',100,100,'quote',now())`,
        ),
      ).rejects.toMatchObject({ code: "23505" })
      await client.query(`DELETE FROM "agreement_template" WHERE id='template'`)
      expect(
        (
          await client.query(
            'SELECT "templateId","termsMarkdown","sourceQuoteId" FROM "agreement"',
          )
        ).rows[0],
      ).toEqual({
        templateId: null,
        termsMarkdown: "Independent terms",
        sourceQuoteId: "quote",
      })
      await expect(
        client.query(`DELETE FROM "quote" WHERE id='quote'`),
      ).rejects.toMatchObject({ code: "23503" })
    } finally {
      await client.query("SET search_path TO public")
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await client.end()
    }
  })
})
