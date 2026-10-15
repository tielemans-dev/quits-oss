import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { Client } from "pg"
import { describe, expect, it } from "vitest"
import { hasTestDatabase } from "../../test-utils/organization"

const target = "20261015000000_org_stripe_connect_account"

describe.runIf(hasTestDatabase)("stripe connect account migration", () => {
  it("adds a unique nullable account id, a status enum defaulting to none, and a nullable timestamp", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const schema = `stripe_connect_${randomUUID().replaceAll("-", "")}`
    const migrations = new URL("../../../prisma/migrations/", import.meta.url)
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      for (const name of (await readdir(migrations)).filter((name) => /^\d/.test(name) && name < target).sort()) {
        await client.query(
          (await readFile(new URL(`${name}/migration.sql`, migrations), "utf8")).replaceAll('"public".', `"${schema}".`)
        )
      }
      await client.query(`
        INSERT INTO organization (id, name, slug, "createdAt") VALUES
          ('org-a', 'Alpha', 'alpha', now()),
          ('org-b', 'Beta', 'beta', now());
        INSERT INTO org_settings (id, "organizationId", "updatedAt") VALUES
          ('settings-a', 'org-a', now()),
          ('settings-b', 'org-b', now());
      `)

      await client.query(
        (await readFile(new URL(`${target}/migration.sql`, migrations), "utf8")).replaceAll('"public".', `"${schema}".`)
      )

      const columns = await client.query<{
        column_name: string
        data_type: string
        udt_name: string
        is_nullable: string
        column_default: string | null
      }>(`
        SELECT column_name, data_type, udt_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'org_settings'
          AND column_name IN ('stripeAccountId', 'stripeAccountStatus', 'stripeAccountStatusAt')
        ORDER BY column_name
      `)
      expect(columns.rows).toEqual([
        {
          column_name: "stripeAccountId",
          data_type: "text",
          udt_name: "text",
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "stripeAccountStatus",
          data_type: "USER-DEFINED",
          udt_name: "StripeAccountStatus",
          is_nullable: "NO",
          column_default: "'none'::\"StripeAccountStatus\"",
        },
        {
          column_name: "stripeAccountStatusAt",
          data_type: "timestamp without time zone",
          udt_name: "timestamp",
          is_nullable: "YES",
          column_default: null,
        },
      ])

      const index = await client.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'org_settings_stripeAccountId_key'`
      )
      expect(index.rows[0]?.indexdef).toContain("UNIQUE")
      expect(index.rows[0]?.indexdef).toContain("stripeAccountId")

      const seeded = await client.query(
        `SELECT id, "stripeAccountId", "stripeAccountStatus"::text AS status, "stripeAccountStatusAt" FROM org_settings ORDER BY id`
      )
      expect(seeded.rows).toEqual([
        { id: "settings-a", stripeAccountId: null, status: "none", stripeAccountStatusAt: null },
        { id: "settings-b", stripeAccountId: null, status: "none", stripeAccountStatusAt: null },
      ])

      await client.query(`UPDATE org_settings SET "stripeAccountId" = 'acct_shared' WHERE id = 'settings-a'`)
      await expect(
        client.query(`UPDATE org_settings SET "stripeAccountId" = 'acct_shared' WHERE id = 'settings-b'`)
      ).rejects.toMatchObject({ code: "23505" })

      await expect(
        client.query(`UPDATE org_settings SET "stripeAccountStatus" = 'disabled' WHERE id = 'settings-a'`)
      ).rejects.toMatchObject({ code: "22P02" })

      await client.query(
        `UPDATE org_settings SET "stripeAccountStatus" = 'active', "stripeAccountStatusAt" = '2026-10-12T12:00:00.000Z' WHERE id = 'settings-a'`
      )
      const active = await client.query(
        `SELECT "stripeAccountStatus"::text AS status FROM org_settings WHERE id = 'settings-a'`
      )
      expect(active.rows[0]?.status).toBe("active")
    } finally {
      await client.query("SET search_path TO public")
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await client.end()
    }
  })
})
