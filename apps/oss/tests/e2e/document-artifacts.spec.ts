import { createServer, type Server } from "node:http"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { executeCommand } from "../../src/domain/execute"
import { createInvoiceDraft } from "../../src/domain/commands/invoices"
import { createAgreementDraft } from "../../src/domain/commands/agreements"
import { resolveUserActor } from "../../src/domain/user-actor"
import { resetDatabase, seedCompletedSetup, loginAsAdmin, waitForClientReady } from "./support"

let provider: Server
let delivered = 0
test.beforeAll(async () => {
  provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the synthetic request. */ }
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ id: `synthetic-artifact-email-${++delivered}` }))
  })
  await new Promise<void>(resolve => provider.listen(3058, "127.0.0.1", resolve))
})
test.afterAll(async () => { await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())) })

test("send invoice, download frozen stored PDF, issue and send credit note, send agreement", async ({ page }) => {
  await resetDatabase()
  const setup = await seedCompletedSetup()
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: setup.organizationId } })
  const actor = await resolveUserActor({ organizationId: setup.organizationId, userId: member.userId })
  if (!actor) throw new Error("Synthetic actor missing")
  const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "Artifact Customer", email: "customer@example.test" } })
  const draft = await executeCommand(createInvoiceDraft, { contactId: contact.id, dueDate: "2099-01-01", taxRate: 0,
    items: [{ description: "Artifact work", quantity: 1, unitPrice: 100 }] }, { actor })
  const agreementDraft = await executeCommand(createAgreementDraft, { contactId: contact.id, title: "Artifact agreement",
    termsMarkdown: "Frozen terms", validUntil: "2099-01-01", deliverables: [{ title: "Work", quantity: 1, unitPrice: 100 }] }, { actor })
  if (draft.status !== "completed" || agreementDraft.status !== "completed") throw new Error("Draft setup failed")
  // Drafts have no number; the invoice takes the next one when it is sent.
  expect(draft.result.number).toBeNull()
  await loginAsAdmin(page)
  await page.goto(`/invoices/${draft.result.id}`)
  await waitForClientReady(page)
  await expect(page.getByRole("heading", { name: "Draft invoice" })).toBeVisible()
  await expect(page.getByText("Numbered INV-0001 when sent. The number is not reserved")).toBeVisible()
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("button", { name: "Resend email", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Invoice INV-0001" })).toBeVisible()
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })
  expect(invoice.number).toBe("INV-0001")
  expect(invoice.artifactPdfRef).toBeTruthy()
  const original = await page.request.get(`/api/documents/invoice/${invoice.id}/pdf`)
  expect(original.headers()["x-quits-artifact"]).toBe("stored")
  const pdf = await original.body()
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-")
  expect(createHash("sha256").update(pdf).digest("hex")).toBe(invoice.artifactPdfHash)
  // Alter live branding and customer data; the published PDF must remain byte-identical.
  await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { companyName: "Changed branding" } })
  await prisma.contact.update({ where: { id: contact.id }, data: { name: "Changed customer" } })
  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("button", { name: "PDF", exact: true }).click()
  const download = await downloadPromise
  const downloaded = await readFile((await download.path())!)
  expect(downloaded).toEqual(pdf)
  await page.screenshot({ path: "/var/tmp/quits-a3a/browser-invoice.png", fullPage: true })

  await page.getByRole("button", { name: "Create credit note", exact: true }).click()
  await page.getByLabel("Reason", { exact: true }).fill("Browser correction")
  await page.getByRole("dialog").getByRole("button", { name: "Issue credit note", exact: true }).click()
  await expect(page.getByRole("dialog")).not.toBeVisible()
  const credit = await prisma.creditNote.findFirstOrThrow({ where: { organizationId: setup.organizationId } })
  expect(credit.artifactPdfRef).toBeTruthy()
  await page.goto(`/credit-notes/${credit.id}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Email credit note", exact: true }).click()
  await expect(page.getByText(/Credit note emailed to/)).toBeVisible()
  const creditPdf = await page.request.get(`/api/documents/creditNote/${credit.id}/pdf`)
  expect(creditPdf.headers()["x-quits-artifact"]).toBe("stored")
  expect(createHash("sha256").update(await creditPdf.body()).digest("hex")).toBe(credit.artifactPdfHash)
  await page.screenshot({ path: "/var/tmp/quits-a3a/browser-credit-note.png", fullPage: true })

  await page.goto(`/agreements/${agreementDraft.result.id}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("link", { name: "Open customer link" })).toBeVisible()
  const agreement = await prisma.agreement.findUniqueOrThrow({ where: { id: agreementDraft.result.id } })
  expect(agreement.artifactPdfRef).toBeTruthy()
  const agreementPdf = await page.request.get(`/api/agreements/${agreement.id}/pdf`)
  expect(agreementPdf.headers()["x-quits-artifact"]).toBe("stored")
  expect(createHash("sha256").update(await agreementPdf.body()).digest("hex")).toBe(agreement.artifactPdfHash)
  const customerUrl = await page.getByRole("link", { name: "Open customer link" }).getAttribute("href")
  const customerPdf = await page.request.get(`${customerUrl}/pdf`)
  expect(customerPdf.headers()["x-quits-artifact"]).toBe("stored")
  expect(await customerPdf.body()).toEqual(await agreementPdf.body())
  await page.screenshot({ path: "/var/tmp/quits-a3a/browser-agreement.png", fullPage: true })
  expect(delivered).toBe(3)
  expect(await prisma.domainEvent.count({ where: { organizationId: setup.organizationId, type: "document.artifact_stored" } })).toBe(3)
})
