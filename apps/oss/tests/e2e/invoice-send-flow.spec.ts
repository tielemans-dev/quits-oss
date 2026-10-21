import { createServer, type Server } from "node:http"
import { expect, test, type Page } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { executeCommand } from "../../src/domain/execute"
import { createInvoiceDraft } from "../../src/domain/commands/invoices"
import { resolveUserActor } from "../../src/domain/user-actor"
import { resetDatabase, seedCompletedSetup, danishLocale, loginAsAdmin, waitForClientReady } from "./support"

// Synthetic local-only journey: the database and the email provider are disposable fixtures.
let provider: Server
let delivered = 0
test.beforeAll(async () => {
  provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Synthetic local email only. */ }
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ id: `synthetic-send-flow-${++delivered}` }))
  })
  await new Promise<void>(resolve => provider.listen(3062, "127.0.0.1", resolve))
})
test.afterAll(async () => { await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())) })

async function seed(taxRate: number) {
  await resetDatabase()
  delivered = 0
  const setup = await seedCompletedSetup({ ...danishLocale, locale: "en-US" })
  await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: {
    companyName: "Synthetic Studio ApS", companyAddress: "Testvej 1, 1000 København", taxRate,
    momsRegistered: true, pricesIncludeTax: false, bankRegNumber: "0040", bankAccountNumber: "0440116243",
  } })
  // A VAT-registered seller must carry a tax ID, or the compliance check refuses the send.
  await prisma.organizationTaxId.create({ data: { organizationId: setup.organizationId, scheme: "cvr", value: "12345674", countryCode: "DK", isPrimary: true } })
  const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "Synthetic Buyer",
    company: "Synthetic Buyer ApS", email: "buyer@example.test", address: "Testvej 2", zip: "1000", city: "København", country: "DK" } })
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: setup.organizationId } })
  const actor = await resolveUserActor({ organizationId: setup.organizationId, userId: member.userId })
  if (!actor) throw new Error("Synthetic actor missing")
  return { organizationId: setup.organizationId, contact, actor }
}

/** Synthetic adopter response: exercises the policy-driven layout without any private hosted code. */
async function fixVatRateByPolicy(page: Page, standardVatRate: string) {
  await page.route("**/api/trpc/**", async route => {
    if (!route.request().url().includes("invoices.sendReadiness")) return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    for (const entry of Array.isArray(body) ? body : [body]) {
      if (entry.result?.data?.json && "standardVatRate" in entry.result.data.json) entry.result.data.json.standardVatRate = standardVatRate
    }
    await route.fulfill({ response, json: body })
  })
}

// "/invoices/new" also looks like "/invoices/<id>", so exclude it or the wait returns before the save.
const savedInvoiceUrl = /\/invoices\/(?!new$)[^/]+$/

async function fillInvoice(page: Page) {
  await page.locator("#invoice-contact").click()
  await page.getByRole("option", { name: "Synthetic Buyer" }).click()
  await page.locator("#dueDate").click()
  await page.getByRole("gridcell").filter({ has: page.getByRole("button", { name: /\b20(?:th)?\b/ }) }).first().getByRole("button").click()
  await page.getByLabel("Description", { exact: true }).fill("Synthetic consulting")
  await page.getByLabel("Unit Price", { exact: true }).fill("1000")
  await waitForClientReady(page)
  await expect(page.getByRole("button", { name: "Save & Send" })).toBeEnabled()
}

test("without a policy-fixed rate: field errors, the full VAT editor, a cancellable confirmation and the send", async ({ page }) => {
  const { organizationId } = await seed(25)
  await loginAsAdmin(page)
  await page.goto("/invoices/new")
  await waitForClientReady(page)
  await expect(page.getByRole("button", { name: "Save & Send" })).toBeEnabled()
  await page.getByRole("button", { name: "Save & Send" }).click()
  await expect(page.getByText("Choose a customer", { exact: true })).toBeVisible()
  await expect(page.getByText("Fill in this field", { exact: true }).first()).toBeVisible()
  await fillInvoice(page)
  const treatment = page.getByRole("combobox", { name: "VAT treatment for line 1" })
  await expect(treatment).toHaveValue("standard")
  await expect(treatment.locator('option[value="intra_community"]')).toHaveCount(1)
  await expect(page.getByRole("spinbutton", { name: "Tax" })).toHaveValue("25")
  await page.getByRole("button", { name: "Save & Send" }).click()
  await expect(page.getByRole("heading", { name: "Send invoice?" })).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click()
  expect(await prisma.invoice.count({ where: { organizationId } })).toBe(0)
  expect(delivered).toBe(0)
  await page.getByRole("button", { name: "Save & Send" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Send invoice", exact: true }).click()
  await page.waitForURL(savedInvoiceUrl)
  await expect.poll(() => delivered, { timeout: 30_000 }).toBe(1)
  expect((await prisma.invoice.findFirstOrThrow({ where: { organizationId } })).status).toBe("sent")
})

test("a new organization goes from no customers to a sent invoice through the customer picker", async ({ page }) => {
  const { organizationId } = await seed(25)
  await prisma.contact.deleteMany({ where: { organizationId } })
  await loginAsAdmin(page)
  await page.goto("/invoices/new")
  await waitForClientReady(page)
  await page.locator("#invoice-contact").click()
  await page.getByRole("option", { name: "Create manually" }).click()
  await page.waitForURL(/\/contacts\/new\?returnTo=/)
  for (const [label, value] of [["Name (required)", "Synthetic Buyer"], ["Company", "Synthetic Buyer ApS"], ["Email", "buyer@example.test"], ["Address", "Testvej 2"], ["City", "København"], ["ZIP", "1000"], ["Tax ID", "24256790"]]) await page.getByLabel(label, { exact: true }).fill(value)
  await page.getByRole("button", { name: "Create Customer" }).click()
  await page.waitForURL(/\/invoices\/new\?contactId=/)
  await expect(page.locator("#invoice-contact")).toHaveText("Synthetic Buyer")
  await fillInvoice(page)
  await page.getByRole("button", { name: "Save & Send" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Send invoice", exact: true }).click()
  await page.waitForURL(savedInvoiceUrl)
  await expect.poll(() => delivered, { timeout: 30_000 }).toBe(1)
  const invoice = await prisma.invoice.findFirstOrThrow({ where: { organizationId }, include: { contact: true } })
  expect([invoice.status, invoice.contact.name, invoice.contact.email]).toEqual(["sent", "Synthetic Buyer", "buyer@example.test"])
})

test("with a policy-fixed rate: plain VAT text instead of a choice, on the new form and the draft editor", async ({ page }) => {
  const { organizationId } = await seed(25)
  await loginAsAdmin(page)
  await fixVatRateByPolicy(page, "25")
  await page.goto("/invoices/new")
  await waitForClientReady(page)
  await expect(page.getByText("25 % VAT", { exact: true })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "VAT treatment for line 1" })).toHaveCount(0)
  await expect(page.getByRole("combobox", { name: "VAT rate for line 1" })).toHaveCount(0)
  await fillInvoice(page)
  await page.getByRole("button", { name: "Save as Draft" }).click()
  await page.waitForURL(savedInvoiceUrl)
  const invoice = await prisma.invoice.findFirstOrThrow({ where: { organizationId }, include: { items: true } })
  expect([invoice.status, invoice.items[0].taxRate.toString()]).toEqual(["draft", "25"])
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(page.getByText("25 % VAT", { exact: true })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "VAT treatment for line 1" })).toHaveCount(0)
})

test("detail page: an all-zero draft restores the configured VAT, a foreign valuation is validated, then the final review sends", async ({ page }) => {
  const { contact, actor } = await seed(20)
  const created = await executeCommand(createInvoiceDraft, {
    contactId: contact.id, currency: "EUR", supplyDate: "2026-10-12", dueDate: "2026-11-12", taxRate: 0,
    items: [{ description: "Synthetic consulting", quantity: 1, unitPrice: 100, vat: { treatment: "out_of_scope", rate: "0" } }],
  }, { actor })
  if (created.status !== "completed") throw new Error("Synthetic draft missing")
  const id = created.result.id
  await loginAsAdmin(page)
  await page.goto(`/invoices/${id}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await page.getByLabel("VAT treatment for line 1").selectOption("standard")
  await page.getByRole("button", { name: "Save Changes", exact: true }).click()
  await expect.poll(async () => {
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id }, include: { items: true } })
    return [invoice.items[0].taxRate.toString(), invoice.totalTax.toString(), invoice.totalGross.toString()]
  }).toEqual(["20", "20", "120"])
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("alert").first()).toBeVisible()
  await page.locator("#exchangeRate").fill("7.45")
  await page.locator("#rateDate").fill("2026-10-12")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Send invoice?", exact: true })).toBeVisible()
  expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("draft")
  await page.getByRole("dialog").getByRole("button", { name: "Send invoice", exact: true }).click()
  await expect.poll(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id } })).lastEmailAttemptOutcome, { timeout: 30_000 }).toBe("sent")
  expect(delivered).toBe(1)
})
