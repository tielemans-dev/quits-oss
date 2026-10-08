import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "pg"
import { describe, expect, it } from "vitest"
import { hasTestDatabase } from "../../test-utils/organization"

const target = "20261014000000_normalize_calendar_dates"
const rows = [
  { id: "east", zone: "europe/copenhagen", value: "2026-07-21 22:30:00", expected: "2026-07-22T00:00:00" },
  { id: "west", zone: "America/New_York", value: "2026-11-22 01:00:00", expected: "2026-11-21T00:00:00" },
  { id: "leap", zone: "UTC", value: "2028-02-29 12:00:00", expected: "2028-02-29T00:00:00" },
  { id: "pago", zone: "Pacific/Pago_Pago", value: "2026-11-07 10:00:00", expected: "2026-11-06T00:00:00" },
  { id: "half-hour", zone: "America/St_Johns", value: "2026-11-01 02:00:00", expected: "2026-10-31T00:00:00" },
  { id: "midnight", zone: "America/New_York", value: "2026-11-07 00:00:00", expected: "2026-11-07T00:00:00" },
  { id: "unknown", zone: "Invalid/Timezone", value: "2026-11-07 23:30:00", expected: "2026-11-07T23:30:00" },
  { id: "empty", zone: "", value: "2026-11-07 23:30:00", expected: "2026-11-07T23:30:00" },
]

// Uses only the assigned test DB, with an isolated schema so other fixtures are untouched.
describe.runIf(hasTestDatabase)("calendar-date normalization migration", () => {
  it("normalizes 10 of 16 seeded rows, skips unknown zones, preserves evidence and is idempotent", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const schema = `calendar_dates_${randomUUID().replaceAll("-", "")}`
    const root = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url))
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      for (const name of (await readdir(root)).filter(name => /^\d/.test(name) && name < target).sort())
        await client.query((await readFile(path.join(root, name, "migration.sql"), "utf8")).replaceAll('"public".', `"${schema}".`))
      await client.query(`
        INSERT INTO organization (id,name,slug,"createdAt") VALUES ('org','Existing','existing',now());
        INSERT INTO org_settings (id,"organizationId",timezone,"updatedAt") VALUES ('settings','org','Asia/Tokyo',now());
        INSERT INTO contact (id,"organizationId",name,"updatedAt") VALUES ('buyer','org','Buyer',now());
        INSERT INTO domain_event (id,"organizationId",sequence,"aggregateType","aggregateId",type,payload,"actorKind")
          VALUES ('event','org',1,'invoice','east','invoice.issued','{"dueDate":"2026-07-21","evidence":"unchanged"}','user');
      `)
      for (const row of rows) {
        await client.query(`INSERT INTO invoice (id,"organizationId","contactId",number,"subtotalNet","totalGross",status,"dueDate","supplyDate",timezone,"issuanceSnapshot","artifactPdfRef","artifactPdfHash","artifactUblRef","artifactUblHash","updatedAt")
          VALUES ($1,'org','buyer',$1,100,100,'sent',$2,'2026-01-01',$3,'{"dueDate":"2026-07-21","evidence":"unchanged"}','old.pdf','pdf-hash','old.xml','ubl-hash',now())`, [row.id, row.value, row.zone])
        await client.query(`INSERT INTO quote (id,"organizationId","contactId",number,"subtotalNet","totalGross","expiryDate","supplyDate",timezone,"updatedAt")
          VALUES ($1,'org','buyer',$1,100,100,$2,'2026-01-01',$3,now())`, [row.id, row.value, row.zone])
      }
      const read = async (table: string) => (await client.query(`SELECT to_jsonb(t) AS value FROM "${table}" t ORDER BY id`)).rows.map(row => row.value)
      const beforeInvoices = await read("invoice"), beforeQuotes = await read("quote"), beforeEvents = await read("domain_event")
      const migration = await readFile(path.join(root, target, "migration.sql"), "utf8")
      const apply = async () => {
        let changed = 0
        for (const sql of migration.split(";").filter(sql => sql.trim())) changed += (await client.query(sql)).rowCount ?? 0
        return changed
      }
      // The session and current organisation timezone deliberately differ from the documents.
      await client.query("SET TIME ZONE 'Pacific/Auckland'")
      expect(await apply()).toBe(10)
      const expected = (before: Array<{ id: string }>, field: string) => before.map(row => ({
        ...row, [field]: rows.find(seed => seed.id === row.id)!.expected,
      }))
      expect(await read("invoice")).toEqual(expected(beforeInvoices, "dueDate"))
      expect(await read("quote")).toEqual(expected(beforeQuotes, "expiryDate"))
      expect(await read("domain_event")).toEqual(beforeEvents)
      await client.query("SET TIME ZONE 'America/Los_Angeles'")
      expect(await apply()).toBe(0)
      expect(await read("invoice")).toEqual(expected(beforeInvoices, "dueDate"))
      expect(await read("quote")).toEqual(expected(beforeQuotes, "expiryDate"))
    } finally {
      await client.query("SET search_path TO public")
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await client.end()
    }
  })
})
