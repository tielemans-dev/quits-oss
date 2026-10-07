import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "pg"
import { describe, expect, it } from "vitest"
import { hasTestDatabase } from "../../../test-utils/organization"

describe.runIf(hasTestDatabase)("event envelope and consumer migration", () => {
  it("initializes historical events to v1 without changing any payload or envelope field", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const schema = `event_a1_${randomUUID().replaceAll("-", "")}`
    const migrations = fileURLToPath(new URL("../../../../prisma/migrations/", import.meta.url))
    const target = "20261007160000_event_envelope_and_consumers"
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      for (const name of (await readdir(migrations)).filter((name) => /^\d/.test(name) && name < target).sort()) {
        await client.query((await readFile(path.join(migrations, name, "migration.sql"), "utf8")).replaceAll('"public".', `"${schema}".`))
      }
      await client.query(`INSERT INTO "organization" (id,name,slug,"createdAt") VALUES ('org','Existing','existing',now());
        INSERT INTO "domain_event" (id,"organizationId",sequence,"aggregateType","aggregateId",type,payload,"actorKind") VALUES ('event','org',1,'contact','contact-1','contact.created','{"name":"Historical","unknownLegacyField":true}','system');`)
      const before = (await client.query('SELECT * FROM "domain_event"')).rows[0]
      await client.query(await readFile(path.join(migrations, target, "migration.sql"), "utf8"))
      expect((await client.query('SELECT * FROM "domain_event"')).rows[0]).toEqual({ ...before, schemaVersion: 1 })
      await expect(client.query('UPDATE "domain_event" SET "schemaVersion" = 0')).rejects.toMatchObject({ code: "23514" })
      await client.query(`INSERT INTO "event_consumer_cursor" (id,"organizationId","consumerKey","updatedAt") VALUES ('cursor','org','bookkeeping',now());`)
      expect((await client.query('SELECT * FROM "event_consumer_cursor"')).rows[0]).toMatchObject({ acknowledgedSequence: 0, scannedSequence: 0, version: 0 })
      await expect(client.query(`INSERT INTO "event_consumer_cursor" (id,"organizationId","consumerKey","updatedAt") VALUES ('duplicate','org','bookkeeping',now())`)).rejects.toMatchObject({ code: "23505" })
      await client.query(`INSERT INTO "event_consumer_delivery" (id,"organizationId","consumerKey",sequence,"updatedAt") VALUES ('delivery','org','bookkeeping',1,now());`)
      expect((await client.query('SELECT * FROM "event_consumer_delivery"')).rows[0]).toMatchObject({ status: "pending", attempts: 0, claimToken: null, leaseUntil: null })
      await expect(client.query(`INSERT INTO "event_consumer_delivery" (id,"organizationId","consumerKey",sequence,"updatedAt") VALUES ('duplicate','org','bookkeeping',1,now())`)).rejects.toMatchObject({ code: "23505" })
    } finally {
      await client.query("SET search_path TO public")
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await client.end()
    }
  })
})
