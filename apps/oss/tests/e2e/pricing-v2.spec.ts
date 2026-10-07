import { createServer, type Server } from "node:http"
import { mkdir } from "node:fs/promises"
import { test, expect, type Page } from "@playwright/test"
import { calculateDraft } from "@quits/shared/pricing"
import { prisma } from "../../src/lib/db"
import { signQuotePublicToken } from "../../src/lib/quotes/public"
import { resetDatabase, seedCompletedSetup, loginAsAdmin, waitForClientReady, appOrigin, publicQuoteSecret } from "./support"

let provider: Server
const messages: Array<{ to: string; html: string }> = []
const artifacts = "/var/tmp/quits-a2a2-browser"
test.beforeAll(async () => {
  await mkdir(artifacts, { recursive: true })
  provider = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    messages.push(JSON.parse(body))
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ id: `synthetic-pricing-email-${messages.length}` }))
  })
  await new Promise<void>((resolve) => provider.listen(3058, "127.0.0.1", resolve))
})
test.afterAll(async () => { await new Promise<void>((resolve) => provider.close(() => resolve())) })
test.beforeEach(async () => { await resetDatabase(); messages.length = 0 })
async function setup(page: Page) {
  const { organizationId } = await seedCompletedSetup()
  const contact = await prisma.contact.create({ data: { organizationId, name: "VAT Customer", email: "customer@example.test", country: "US" } })
  await loginAsAdmin(page)
  return { organizationId, contactId: contact.id }
}
async function chooseDate(page: Page, id: string) {
  await page.locator(`#${id}`).click()
  await page.getByRole("gridcell").filter({ has: page.getByRole("button", { name: /\b20(?:th)?\b/ }) }).first().getByRole("button").click()
  await page.keyboard.press("Escape")
}
async function fillNewDocument(page: Page, kind: "invoices" | "quotes") {
  await page.goto(`/${kind}/new`)
  await waitForClientReady(page)
  await page.getByRole("combobox").first().click()
  await page.getByRole("option", { name: "VAT Customer" }).click()
  await chooseDate(page, kind === "invoices" ? "dueDate" : "expiryDate")
  await page.getByRole("spinbutton").last().fill("25")
  await page.getByPlaceholder("Description", { exact: true }).first().fill("Standard service")
  await page.getByRole("spinbutton").nth(0).fill("1")
  await page.getByRole("spinbutton").nth(1).fill("100")
}

test("creates and sends an invoice with two VAT groups matching the calculator", async ({ page }) => {
  const { organizationId } = await setup(page)
  await fillNewDocument(page, "invoices")
  await page.getByRole("button", { name: "Add Item", exact: true }).click()
  await page.getByPlaceholder("Description", { exact: true }).nth(1).fill("Health service")
  await page.getByRole("spinbutton").nth(3).fill("100")
  await page.getByLabel("VAT treatment for line 2").selectOption("exempt")
  await page.getByLabel("VAT reason for line 2").selectOption("health")
  await page.getByLabel("VAT statement / exemption reason").fill("Health exemption")
  const expected = calculateDraft({ currency: "USD", pricesIncludeTax: false, taxRate: "25", items: [
    { description: "Standard service", quantity: "1", unitPrice: "100" },
    { description: "Health service", quantity: "1", unitPrice: "100", vat: { treatment: "exempt", reasonCode: "health" } },
  ] })
  const groups = page.getByLabel("VAT group totals")
  await expect(groups).toContainText("Net $100.00, VAT $25.00, total $125.00")
  await expect(groups).toContainText("Net $100.00, VAT $0.00, total $100.00")
  await page.screenshot({ path: `${artifacts}/mixed-vat-preview.png`, fullPage: true })
  await page.getByRole("button", { name: "Save & Send", exact: true }).click()
  await page.waitForURL((url) => url.pathname.startsWith("/invoices/") && !url.pathname.endsWith("/new"))
  const id = new URL(page.url()).pathname.split("/").at(-1)!
  await expect.poll(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("sent")
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { sortOrder: "asc" } } } })
  expect(invoice.organizationId).toBe(organizationId)
  expect(invoice.calculationVersion).toBe("v2")
  expect([invoice.subtotalNet.toFixed(2), invoice.totalTax.toFixed(2), invoice.totalGross.toFixed(2)]).toEqual([expected.net, expected.tax, expected.gross])
  expect(invoice.items.map((line) => [line.vatTreatment, line.lineTax.toFixed(2)])).toEqual([["standard", "25.00"], ["exempt", "0.00"]])
  expect(messages).toHaveLength(1)
  expect(messages[0]!.to).toBe("customer@example.test")
  await page.screenshot({ path: `${artifacts}/mixed-vat-sent.png`, fullPage: true })
})

test("editing a legacy draft shows v2 group rounding and upgrades its stored version", async ({ page }) => {
  const { organizationId, contactId } = await setup(page)
  const invoice = await prisma.invoice.create({ data: {
    organizationId, contactId, number: "LEGACY-BROWSER", status: "draft", dueDate: new Date("2026-12-01"), currency: "USD", subtotalNet: "0.06", totalTax: "0.03", totalGross: "0.09",
    items: { create: Array.from({ length: 3 }, (_, sortOrder) => ({ description: `Legacy ${sortOrder + 1}`, quantity: "1", quantityInput: "1", unitPriceNet: "0.02", unitPriceGross: "0.03", unitPriceInput: "0.02", inputPrecision: "backfilled", lineNet: "0.02", lineTax: "0.01", lineGross: "0.03", taxRate: "25", vatTreatment: "standard", sortOrder })) },
  } })
  await page.goto(`/invoices/${invoice.id}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(page.getByLabel("VAT group totals")).toContainText("Net $0.06, VAT $0.02, total $0.08")
  await page.screenshot({ path: `${artifacts}/legacy-edit-preview.png`, fullPage: true })
  await page.getByRole("button", { name: "Save Changes", exact: true }).click()
  await expect.poll(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).calculationVersion).toBe("v2")
  expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).totalGross.toString()).toBe("0.08")
})

test("creates a quote, sends it, accepts it as the customer and converts frozen v2 amounts", async ({ page, browser }) => {
  await setup(page)
  await fillNewDocument(page, "quotes")
  await page.getByRole("spinbutton").nth(0).fill("0.123456")
  await page.getByRole("spinbutton").nth(1).fill("123.4567")
  await page.getByRole("button", { name: "Save as Draft", exact: true }).click()
  await page.waitForURL((url) => url.pathname.startsWith("/quotes/") && !url.pathname.endsWith("/new"))
  const id = new URL(page.url()).pathname.split("/").at(-1)!
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(page.getByRole("spinbutton").nth(0)).toHaveValue("0.123456")
  await expect(page.getByRole("spinbutton").nth(1)).toHaveValue("123.4567")
  await page.getByRole("spinbutton").nth(1).fill("223.4567")
  const preview = calculateDraft({ currency: "USD", taxRate: "25", pricesIncludeTax: false, items: [{ description: "Standard service", quantity: "0.123456", unitPrice: "223.4567" }] })
  await expect(page.getByLabel("VAT group totals")).toContainText(`total $${preview.gross}`)
  await page.getByRole("button", { name: "Save Changes", exact: true }).click()
  await expect.poll(async () => (await prisma.quoteItem.findFirstOrThrow({ where: { quoteId: id } })).unitPriceInput).toBe("223.4567")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect.poll(async () => (await prisma.quote.findUniqueOrThrow({ where: { id } })).status).toBe("sent")
  expect(messages).toHaveLength(1)
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id }, include: { items: true } })
  expect(quote.calculationVersion).toBe("v2")
  const token = signQuotePublicToken({ quoteId: id, keyVersion: quote.publicAccessKeyVersion, scope: "quote_public" }, publicQuoteSecret)
  const customer = await browser.newContext()
  const customerPage = await customer.newPage()
  await customerPage.goto(`${appOrigin}/q/${encodeURIComponent(token)}`)
  await waitForClientReady(customerPage)
  await customerPage.getByRole("button", { name: "Accept quote" }).click()
  await expect(customerPage.getByText("Quote accepted")).toBeVisible()
  await customer.close()
  await page.reload()
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Convert to Invoice", exact: true }).click()
  await page.waitForURL((url) => url.pathname.startsWith("/invoices/") && !url.pathname.endsWith("/new"))
  const invoiceId = new URL(page.url()).pathname.split("/").at(-1)!
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { items: true } })
  expect(invoice.calculationVersion).toBe(quote.calculationVersion)
  expect(invoice.totalGross.toString()).toBe(quote.totalGross.toString())
  expect(invoice.items[0]).toMatchObject({ quantityInput: "0.123456", unitPriceInput: "223.4567" })
  await page.screenshot({ path: `${artifacts}/converted-quote.png`, fullPage: true })
})

test("creates and edits a recurring template with exact decimal inputs, then generates a v2 invoice", async ({ page }) => {
  const { organizationId } = await setup(page)
  await page.goto("/recurring")
  await waitForClientReady(page)
  await page.getByRole("button", { name: "New schedule", exact: true }).first().click()
  const dialog = page.getByRole("dialog")
  await dialog.locator("#recurring-name").fill("Exact recurring template")
  await dialog.getByRole("combobox").first().click()
  await page.getByRole("option", { name: "VAT Customer" }).click()
  await dialog.getByPlaceholder("Description", { exact: true }).fill("Precise service")
  await dialog.getByRole("spinbutton").nth(0).fill("1.123456")
  await dialog.getByRole("spinbutton").nth(1).fill("1000.1234")
  await dialog.getByRole("spinbutton").nth(2).fill("8.2555")
  const expected = calculateDraft({ currency: "USD", pricesIncludeTax: false, taxRate: "8.2555", items: [{ description: "Precise service", quantity: "1.123456", unitPrice: "1000.1234" }] })
  await expect(dialog.getByLabel("VAT group totals")).toContainText(`total $${Number(expected.gross).toLocaleString("en-US", { minimumFractionDigits: 2 })}`)
  await page.screenshot({ path: `${artifacts}/recurring-preview.png`, fullPage: true })
  await dialog.getByRole("button", { name: "Create schedule", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.getByRole("link", { name: "Exact recurring template", exact: true }).click()
  await waitForClientReady(page)
  const id = new URL(page.url()).pathname.split("/").at(-1)!
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(dialog.getByRole("spinbutton").nth(0)).toHaveValue("1.123456")
  await expect(dialog.getByRole("spinbutton").nth(1)).toHaveValue("1000.1234")
  await expect(dialog.getByLabel("VAT rate for line 1")).toHaveValue("0.082555")
  await dialog.locator("#recurring-notes").fill("Preserve exact inputs")
  await dialog.getByRole("button", { name: "Save schedule", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.getByRole("button", { name: "Generate now", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Generate now", exact: true }).click()
  await expect.poll(async () => prisma.invoice.count({ where: { recurringInvoiceId: id } })).toBe(1)
  const invoice = await prisma.invoice.findFirstOrThrow({ where: { recurringInvoiceId: id }, include: { items: true } })
  expect(invoice.organizationId).toBe(organizationId)
  expect(invoice.calculationVersion).toBe("v2")
  expect(invoice.items[0]).toMatchObject({ quantityInput: "1.123456", unitPriceInput: "1000.1234", vatRateInput: "0.082555" })
  expect([invoice.subtotalNet.toFixed(2), invoice.totalTax.toFixed(2), invoice.totalGross.toFixed(2)]).toEqual([expected.net, expected.tax, expected.gross])
})
