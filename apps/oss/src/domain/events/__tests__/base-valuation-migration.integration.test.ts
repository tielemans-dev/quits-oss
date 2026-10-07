import { randomUUID } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { Client } from "pg"
import { describe, expect, it } from "vitest"
import { hasTestDatabase } from "../../../test-utils/organization"

describe.runIf(hasTestDatabase)("A3b additive migration", () => {
  it("backfills country base currency and unknown historical valuations without changing events, amounts or dates", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const schema = `a3b_${randomUUID().replaceAll("-", "")}`
    const migrations = fileURLToPath(new URL("../../../../prisma/migrations/", import.meta.url))
    const target = "20261007200000_base_valuation"
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      for (const name of (await readdir(migrations)).filter(name => /^\d/.test(name) && name < target).sort()) await client.query((await readFile(path.join(migrations, name, "migration.sql"), "utf8")).replaceAll('"public".', `"${schema}".`))
      await client.query(`INSERT INTO "organization" (id,name,slug,"createdAt") VALUES ('org','Existing','existing',now());
        INSERT INTO "org_settings" (id,"organizationId","countryCode","defaultCurrency","updatedAt") VALUES ('settings','org','DK','EUR',now());
        INSERT INTO "contact" (id,"organizationId",name,"updatedAt") VALUES ('buyer','org','Buyer',now());
        INSERT INTO "invoice" (id,"organizationId","contactId",number,status,"dueDate","subtotalNet","totalTax","totalGross",currency,"updatedAt") VALUES ('invoice','org','buyer','INV-1','sent',now(),100,25,125,'EUR',now());
        INSERT INTO "domain_event" (id,"organizationId",sequence,"aggregateType","aggregateId",type,payload,"actorKind") VALUES ('event','org',1,'invoice','invoice','invoice.sent','{"number":"INV-1","recipient":null}','system');`)
      const before = (await client.query('SELECT * FROM "invoice"')).rows[0]
      const event = (await client.query('SELECT * FROM "domain_event"')).rows[0]
      await client.query(await readFile(path.join(migrations, target, "migration.sql"), "utf8"))
      expect((await client.query('SELECT "baseCurrency","defaultCurrency" FROM "org_settings"')).rows[0]).toEqual({ baseCurrency: "DKK", defaultCurrency: "EUR" })
      const after = (await client.query('SELECT * FROM "invoice"')).rows[0]
      expect(after).toEqual({ ...before, valuation: { base: { minor: null, currency: "DKK", exponent: 2 }, rate: null, rateScale: null, rateDate: null, rateSource: "unknown" }, issuanceSnapshot: null })
      expect((await client.query('SELECT * FROM "domain_event"')).rows[0]).toEqual(event)
    } finally {
      await client.query("SET search_path TO public")
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await client.end()
    }
  })
})
