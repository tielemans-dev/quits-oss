import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "pg"
import { describe, expect, it } from "vitest"
import { hasTestDatabase } from "../../test-utils/organization"

const protectedConstraints = [
  "org_settings_organizationId_fkey", "contact_organizationId_fkey", "organization_tax_id_organizationId_fkey",
  "invoice_organizationId_fkey", "invoice_item_invoiceId_fkey", "invoice_reminder_invoiceId_fkey",
  "quote_organizationId_fkey", "quote_item_quoteId_fkey", "credit_note_organizationId_fkey",
  "credit_note_item_creditNoteId_fkey", "payment_organizationId_fkey", "recurring_invoice_organizationId_fkey",
  "domain_event_organizationId_fkey", "approval_request_organizationId_fkey", "approval_request_agentKeyId_fkey",
  "agent_key_organizationId_fkey", "agreement_organizationId_fkey", "deliverable_agreementId_fkey",
  "agreement_template_organizationId_fkey", "artifact_staging_organizationId_fkey", "issuance_candidate_organizationId_fkey",
]

describe.runIf(hasTestDatabase)("financial deletion guard migration", () => {
  it("preserves existing financial rows and replaces only the intended deletion actions", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const schema = `financial_guards_${randomUUID().replaceAll("-", "")}`
    const root = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url))
    const target = "20261007220000_financial_deletion_guards"
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      for (const name of (await readdir(root)).filter((name) => /^\d/.test(name) && name < target).sort()) {
        await client.query((await readFile(path.join(root, name, "migration.sql"), "utf8")).replaceAll('"public".', `"${schema}".`))
      }
      await client.query(`
        INSERT INTO organization (id,name,slug,"createdAt") VALUES ('org','Existing seller','existing-seller',now());
        INSERT INTO org_settings (id,"organizationId","companyName","updatedAt") VALUES ('settings','org','Frozen seller',now());
        INSERT INTO contact (id,"organizationId",name,"updatedAt") VALUES ('contact','org','Existing buyer',now());
        INSERT INTO organization_tax_id (id,"organizationId",scheme,value,"updatedAt") VALUES ('tax','org','vat','123',now());
        INSERT INTO invoice (id,"organizationId","contactId",number,status,"dueDate","subtotalNet","totalGross","sellerSnapshot","buyerSnapshot","artifactPdfRef","artifactPdfHash","updatedAt")
          VALUES ('invoice','org','contact','INV-1','sent',now(),100,100,'{"name":"Frozen seller"}','{"name":"Frozen buyer"}','stored/invoice.pdf','frozen-pdf-hash',now());
        INSERT INTO invoice_item (id,"invoiceId",description,quantity,"unitPriceNet","unitPriceGross","lineNet","lineGross","taxRate")
          VALUES ('invoice-item','invoice','Work',1,100,100,100,100,0);
        INSERT INTO invoice_reminder (id,"invoiceId","offsetDays","scheduledFor","sentAt",outcome)
          VALUES ('reminder','invoice',7,now(),now(),'sent');
        INSERT INTO credit_note (id,"organizationId","invoiceId","contactId",number,reason,"subtotalNet","totalGross",currency,"countryCode",locale,timezone,"taxRegime","updatedAt")
          VALUES ('credit','org','invoice','contact','CN-1','Return',25,25,'USD','US','en-US','UTC','us_sales_tax',now());
        INSERT INTO credit_note_item (id,"creditNoteId",description,quantity,"unitPriceNet","unitPriceGross","lineNet","lineGross","taxRate")
          VALUES ('credit-item','credit','Return',1,25,25,25,25,0);
        INSERT INTO payment (id,"organizationId","invoiceId",amount,currency,"paidAt",method,source,"updatedAt")
          VALUES ('payment','org','invoice',50,'USD',now(),'bank_transfer','user',now());
        INSERT INTO domain_event (id,"organizationId",sequence,"aggregateType","aggregateId",type,payload,"actorKind")
          VALUES ('event','org',1,'invoice','invoice','invoice.issued','{"proof":"historical","unknownLegacyField":true}','user');
        INSERT INTO quote (id,"organizationId","contactId",number,"expiryDate","subtotalNet","totalGross","updatedAt")
          VALUES ('quote','org','contact','QTE-1',now(),100,100,now());
        INSERT INTO quote_item (id,"quoteId",description,quantity,"unitPriceNet","unitPriceGross","lineNet","lineGross","taxRate")
          VALUES ('quote-item','quote','Work',1,100,100,100,100,0);
        INSERT INTO agreement_template (id,"organizationId",name,"termsMarkdown","updatedAt") VALUES ('template','org','Terms','Frozen terms',now());
        INSERT INTO agreement (id,"organizationId","contactId",title,"termsMarkdown","templateId","validUntil","subtotalNet","totalGross","updatedAt")
          VALUES ('agreement','org','contact','Offer','Frozen terms','template','2099-01-01',100,100,now());
        INSERT INTO deliverable (id,"agreementId",title,description,quantity,"unitPriceNet","unitPriceGross","lineNet","lineGross","taxRate")
          VALUES ('deliverable','agreement','Work','Work',1,100,100,100,100,0);
        INSERT INTO recurring_invoice (id,"organizationId","contactId",name,"startDate","nextRunAt",currency,"taxRate",items,"updatedAt")
          VALUES ('recurring','org','contact','Monthly',now(),now(),'USD',0,'[]',now());
        INSERT INTO agent_key (id,"organizationId",name,scopes,"secretHash","displayPrefix","createdByUserId")
          VALUES ('key','org','Agent','{}','secret-hash','quits_ak_','historical-user');
        INSERT INTO approval_request (id,"organizationId","agentKeyId","commandReceiptId","commandType",command,summary,status,"expiresAt")
          VALUES ('approval','org','key','receipt','invoice.send','{"id":"invoice"}','Approved issue','approved',now());
        INSERT INTO artifact_staging (id,"organizationId","documentKind","documentId","requestKey","renderInputHash","renderInput","rendererVersion","leaseUntil",artifacts,"updatedAt")
          VALUES ('staging','org','invoice','invoice','request','render-hash','{"frozen":true}','renderer-v1',now(),'[{"ref":"stored/invoice.pdf"}]',now());
        INSERT INTO issuance_candidate (id,"organizationId","documentKind","documentId","stagingId","renderInput","renderInputHash","attemptAt",artifacts)
          VALUES ('candidate','org','invoice','invoice','staging','{"frozen":true}','render-hash',now(),'[{"ref":"stored/invoice.pdf"}]');
      `)
      const tables = ["organization", "org_settings", "contact", "organization_tax_id", "invoice", "invoice_item",
        "invoice_reminder", "credit_note", "credit_note_item", "payment", "domain_event", "quote", "quote_item",
        "agreement", "deliverable", "agreement_template", "recurring_invoice", "agent_key", "approval_request", "artifact_staging", "issuance_candidate"]
      async function readRows() {
        const rows = []
        for (const table of tables) rows.push((await client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows)
        return rows
      }
      const before = await readRows()
      const constraints = () => client.query<{ conname: string; confdeltype: string }>(`
        SELECT conname, confdeltype FROM pg_constraint
        WHERE contype = 'f' AND connamespace = $1::regnamespace ORDER BY conname
      `, [schema])
      const oldActions = (await constraints()).rows
      await client.query(await readFile(path.join(root, target, "migration.sql"), "utf8"))
      expect(await readRows()).toEqual(before)
      const newActions = (await constraints()).rows
      expect(newActions).toEqual(oldActions.map((constraint) => ({ ...constraint,
        confdeltype: protectedConstraints.includes(constraint.conname) ? "r" : constraint.confdeltype,
      })))
      expect(newActions.filter(({ conname }) => protectedConstraints.includes(conname))).toHaveLength(protectedConstraints.length)
      for (const table of ["organization", "invoice", "quote", "credit_note", "agreement", "agent_key", "artifact_staging"]) {
        await expect(client.query(`DELETE FROM "${table}"`)).rejects.toMatchObject({ code: "23503" })
      }
      expect(await readRows()).toEqual(before)
    } finally {
      await client.query("ROLLBACK")
      await client.query("SET search_path TO public")
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await client.end()
    }
  })
})
