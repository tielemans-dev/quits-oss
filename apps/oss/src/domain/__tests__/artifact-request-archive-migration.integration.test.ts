import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "pg"
import { describe, expect, it } from "vitest"
import { hasTestDatabase } from "../../test-utils/organization"

const target = "20261014050000_artifact_request_archive"
describe.runIf(hasTestDatabase)("artifact request archive migration", () => {
  it("separates legacy owners and preserves ordinary/live/allocated rows and failed receipts", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const schema = `request_archive_${randomUUID().replaceAll("-", "")}`
    const root = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url))
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      for (const name of (await readdir(root)).filter(name => /^\d/.test(name) && name < target).sort())
        await client.query((await readFile(path.join(root, name, "migration.sql"), "utf8")).replaceAll('"public".', `"${schema}".`))
      await client.query(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ('org','Synthetic','synthetic',now());
        INSERT INTO command_receipt (id,"organizationId","actorKey","clientRequestId","commandType",status,error,"updatedAt")
        VALUES ('failed','org','actor','already-failed','agreement.issue','failed','{"code":"reservation_expired"}',now());`)
      const fixtures = [
        { id: "old", key: "owner#superseded:literal#superseded:old", aliases: ["alias#superseded:old", "literal#superseded:embedded#superseded:old"], status: "abandoned", kind: "agreement", allocated: false, archived: ["owner#superseded:literal", "alias", "literal#superseded:embedded"] },
        { id: "invoice", key: "invoice-owner#superseded:invoice", aliases: ["baseline-alias"], status: "abandoned", kind: "invoice", allocated: false, archived: ["invoice-owner", "baseline-alias"] },
        { id: "ordinary", key: "ordinary", aliases: ["ordinary-alias"], status: "abandoned", kind: "agreement", allocated: false, archived: [] },
        { id: "near", key: "near#superseded:other", aliases: [], status: "abandoned", kind: "agreement", allocated: false, archived: [] },
        { id: "live", key: "live#superseded:live", aliases: ["live-alias"], status: "stored", kind: "agreement", allocated: false, archived: [] },
        { id: "allocated", key: "allocated#superseded:allocated", aliases: [], status: "abandoned", kind: "agreement", allocated: true, archived: [] },
        { id: "credit", key: "credit#superseded:credit", aliases: [], status: "abandoned", kind: "creditNote", allocated: false, archived: [] },
      ]
      for (const row of fixtures) await client.query(`INSERT INTO artifact_staging
        (id,"organizationId","documentKind","documentId","requestKey","requestKeys","renderInputHash","renderInput","rendererVersion",status,"leaseUntil","numberWasAllocated","updatedAt")
        VALUES ($1,'org',$2,$1,$3,$4,$1,'{"frozen":true}','historical',$5,'2099-01-01',$6,'2026-01-01')`,
      [row.id, row.kind, row.key, row.aliases, row.status, row.allocated])
      const before = (await client.query('SELECT * FROM artifact_staging ORDER BY id')).rows
      const receipts = (await client.query('SELECT * FROM command_receipt')).rows
      await client.query(await readFile(path.join(root, target, "migration.sql"), "utf8"))
      const after = (await client.query('SELECT * FROM artifact_staging ORDER BY id')).rows
      expect(after).toEqual(before.map(row => {
        const fixture = fixtures.find(value => value.id === row.id)!
        return { ...row, archivedRequestKeys: fixture.archived,
          ...(fixture.archived.length ? { requestKey: null, requestKeys: [] } : {}) }
      }))
      expect((await client.query('SELECT * FROM command_receipt')).rows).toEqual(receipts)
      // Multiple NULL primary archives coexist. An arbitrary live string can equal an old encoding.
      await client.query(`INSERT INTO artifact_staging
        (id,"organizationId","documentKind","documentId","requestKey","renderInputHash","renderInput","rendererVersion","leaseUntil","updatedAt")
        VALUES ('new','org','agreement','new',$1,'new','{}','new','2099-01-01',now())`, [fixtures[0]!.key])
      await expect(client.query(`UPDATE artifact_staging SET "requestKey" = $1 WHERE id = 'ordinary'`, [fixtures[0]!.key])).rejects.toMatchObject({ code: "23505" })
      expect((await client.query('SELECT count(*)::int AS count FROM artifact_staging WHERE "requestKey" IS NULL')).rows).toEqual([{ count: 2 }])
    } finally {
      await client.query("SET search_path TO public")
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await client.end()
    }
  })
})
