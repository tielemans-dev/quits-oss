import { randomUUID } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { Client } from "pg"
import { describe, expect, it } from "vitest"
import { hasTestDatabase } from "../../test-utils/organization"

describe.runIf(hasTestDatabase)("additive receipt migration", () => {
  it("preserves legacy payment quantities and rejects invalid receipt equations", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const schema = `receipt_${randomUUID().replaceAll("-", "")}`
    const migrations = new URL("../../../prisma/migrations/", import.meta.url)
    const target = "20261014010000_settlement_receipts"
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      for (const name of (await readdir(migrations)).filter(name => /^\d/.test(name) && name < target).sort()) {
        await client.query((await readFile(new URL(`${name}/migration.sql`, migrations), "utf8")).replaceAll('"public".', `"${schema}".`))
      }
      await client.query(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ('org','Legacy','legacy',now());
        INSERT INTO contact (id,"organizationId",name,"updatedAt") VALUES ('contact','org','Customer',now());
        INSERT INTO invoice (id,"organizationId","contactId",number,status,"dueDate","subtotalNet","totalTax","totalGross",currency,"updatedAt") VALUES ('invoice','org','contact','INV-1','sent',now(),800,200,1000,'DKK',now());
        INSERT INTO payment (id,"organizationId","invoiceId",amount,currency,"paidAt",method,source,"updatedAt") VALUES ('payment','org','invoice',985,'DKK',now(),'bank_transfer','user',now());`)
      const before = (await client.query('SELECT * FROM payment')).rows[0]
      await client.query(await readFile(new URL(`${target}/migration.sql`, migrations), "utf8"))
      expect((await client.query('SELECT * FROM payment')).rows[0]).toEqual({ ...before, receiptId: null, receiptAmount: null, allocationReason: null, allocationEvidence: null, exchangeReason: null, exchangeEvidence: null })
      const insert = `INSERT INTO settlement_receipt (id,"organizationId","contactId",currency,"grossAmount","netAmount","feeAmount","paidAt",method,reference,reason,evidence,"actorKey","commandId") VALUES ('receipt','org','contact','DKK',1000,985,15,now(),'bank_transfer','R-1','Fee','https://example.test/fee','user:1','cmd-1')`
      await expect(client.query(insert)).rejects.toMatchObject({ code: "23514" })
      await client.query(insert.replace('"actorKey","commandId")', '"actorKey","commandId","feeReason","feeEvidence")').replace("'user:1','cmd-1')", "'user:1','cmd-1','Documented fee','https://example.test/fee')"))
      await expect(client.query(`UPDATE settlement_receipt SET "grossAmount" = 999`)).rejects.toMatchObject({ code: "23514" })
      await expect(client.query(`UPDATE payment SET "receiptId" = 'receipt', "allocationReason" = 'Allocation', "allocationEvidence" = 'https://example.test/allocation'`)).rejects.toMatchObject({ code: "23514" })
    } finally {
      await client.query("SET search_path TO public")
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await client.end()
    }
  })
})
