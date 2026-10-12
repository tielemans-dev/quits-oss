import { readFile } from "node:fs/promises"
import { inflateSync } from "node:zlib"
import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { priceDocumentV2 } from "../../src/domain/documents/pricing"
import { loginAsAdmin, resetDatabase, seedCompletedSetup, waitForClientReady } from "./support"

test("opens an issued credit note, emails it locally, records sending and downloads its PDF", async ({ page }, testInfo) => {
  test.skip(!process.env.MAILPIT_URL, "Requires a local Mailpit server and SMTP configured for the app")
  await resetDatabase()
  // MOCK: isolated e2e organization and financial fixtures; never used by runtime code.
  const { organizationId } = await seedCompletedSetup()
  const contact = await prisma.contact.create({ data: { organizationId, name: "Credit test buyer", email: "credit-qui64@example.test" } })
  const priced = priceDocumentV2({ currency: "USD", pricesIncludeTax: false, taxRate: "25",
    items: [{ description: "Credit test work", quantity: "1", unitPrice: "100" }] })
  const invoice = await prisma.invoice.create({ data: { organizationId, contactId: contact.id, status: "draft", number: null,
    dueDate: new Date("2099-01-01"), supplyDate: new Date("2026-10-11"), currency: "USD", countryCode: "US", locale: "en-US",
    calculationVersion: "v2", subtotalNet: priced.subtotalNet, totalTax: priced.totalTax, totalGross: priced.totalGross,
    items: { create: priced.itemRows } } })
  await loginAsAdmin(page)
  await page.goto(`/invoices/${invoice.id}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("button", { name: "Create credit note", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Create credit note", exact: true }).click()
  await page.getByLabel("Reason", { exact: true }).fill("Local test correction")
  await page.getByRole("dialog").getByRole("button", { name: "Issue credit note", exact: true }).click()
  await page.waitForURL(/\/credit-notes\/doc_/)
  await expect(page.getByRole("heading", { name: "Credit note CN-0001", exact: true })).toBeVisible()
  const credit = await prisma.creditNote.findFirstOrThrow({ where: { organizationId } })
  await page.reload()
  await waitForClientReady(page)
  await expect(page.getByRole("heading", { name: "Credit note CN-0001", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Email credit note", exact: true }).click()
  await expect(page.getByText(/Emailed on/)).toBeVisible()
  await expect.poll(async () => (await prisma.creditNote.findUniqueOrThrow({ where: { id: credit.id } })).lastEmailAttemptOutcome).toBe("sent")
  await expect.poll(async () => {
    const response = await page.request.get(`${process.env.MAILPIT_URL}/api/v1/search?query=CN-0001`)
    const mail = await response.json()
    return mail.messages?.some((message: { To: Array<{ Address: string }> }) => message.To.some(to => to.Address === contact.email))
  }).toBe(true)
  expect(await prisma.domainEvent.count({ where: { organizationId, aggregateId: credit.id, type: "credit_note.sent" } })).toBe(1)
  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("button", { name: "PDF", exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toContain(credit.number)
  const pdf = await readFile((await download.path())!)
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-")
  expect(pdf.toString("latin1")).toContain("%%EOF")
  // React-PDF uses FlateDecode content streams with hex-encoded text. Check the actual
  // document number in those streams, rather than trusting the download's filename.
  const streams = [...pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].flatMap(match => {
    try { return [inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1")] } catch { return [] }
  }).join("\n")
  const text = [...streams.matchAll(/<([0-9a-f]+)>/gi)].map(match => Buffer.from(match[1]!, "hex").toString()).join("")
  expect(text).toContain(credit.number)
  await page.screenshot({ path: testInfo.outputPath("credit-note-sent.png"), fullPage: true })
  await page.goto(`/invoices/${invoice.id}`)
  await waitForClientReady(page)
  const link = page.getByRole("link", { name: credit.number, exact: true })
  await expect(link).toHaveAttribute("href", `/credit-notes/${credit.id}`)
  await link.click()
  await expect(page.getByRole("heading", { name: "Credit note CN-0001", exact: true })).toBeVisible()
})
