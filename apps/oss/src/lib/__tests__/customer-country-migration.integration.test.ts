import { readFileSync } from "node:fs"
import { Client } from "pg"
import { describe, expect, it } from "vitest"

;(process.env.DATABASE_URL ? describe : describe.skip)("customer country migration", () => {
  it("normalizes known names, retains unknowns without logging customer data and is repeatable", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    const notices: string[] = []
    client.on("notice", notice => notices.push(notice.message ?? ""))
    try {
      await client.query("BEGIN")
      await client.query('CREATE TEMP TABLE "contact" ("country" text) ON COMMIT DROP')
      for (const country of ["Danmark", "Denmark", "dk", "DK", "  Danmark  ", "Sweden", "Sverige", "se", "Synthetic unknown", "Synthetic private name and address", "", null]) {
        await client.query('INSERT INTO "contact" (country) VALUES ($1)', [country])
      }
      const sql = readFileSync(new URL("../../../prisma/migrations/20261014070000_customer_country_codes/migration.sql", import.meta.url), "utf8")
      await client.query(sql)
      const first = await client.query('SELECT "country" FROM "contact"')
      expect(first.rows.map(row => row.country).sort()).toEqual(["DK", "DK", "DK", "DK", "DK", "SE", "SE", "SE", "Synthetic unknown", "Synthetic private name and address", "", null].sort())
      expect(notices).toContain("Unrecognised customer countries: 2 contacts left unchanged")
      expect(notices.join("\n")).not.toMatch(/Synthetic unknown|Synthetic private name and address/)
      await client.query(sql)
      expect((await client.query('SELECT "country" FROM "contact"')).rows).toEqual(first.rows)
    } finally { await client.query("ROLLBACK"); await client.end() }
  })
})
