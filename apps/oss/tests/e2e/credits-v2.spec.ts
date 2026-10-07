import { mkdir, readFile } from "node:fs/promises"
import { test, expect } from "@playwright/test"
import { creditedGroupsSchema } from "@quits/contracts/pricing"
import { prisma } from "../../src/lib/db"
import { priceDocumentV2 } from "../../src/domain/documents/pricing"
import { resetDatabase, seedCompletedSetup, loginAsAdmin, waitForClientReady } from "./support"

const artifacts = "/var/tmp/quits-a2b-browser"
test.beforeEach(async () => { await resetDatabase(); await mkdir(artifacts, { recursive: true }) })
test("issues successive amount credits, downloads stored invoice UBL and refuses a missing legacy artifact", async ({ page }) => {
  const { organizationId } = await seedCompletedSetup()
  await prisma.orgSettings.update({ where: { organizationId }, data: { countryCode: "DK", baseCurrency: "DKK", companyName: "Frozen Seller", companyAddress: "Seller Road 1\n9000 Aalborg" } })
  await prisma.organizationTaxId.create({ data: { organizationId, scheme: "cvr", value: "12345678", isPrimary: true } })
  const contact = await prisma.contact.create({ data: { organizationId, name: "Credit Customer", email: "credit@example.test", country: "DK", address: "Buyer Road 2", city: "Aalborg", taxId: "DK87654321" } })
  const priced = priceDocumentV2({ currency: "DKK", pricesIncludeTax: false, taxRate: "25",
    items: Array.from({ length: 3 }, () => ({ description: "Tiny frozen line", quantity: "1", unitPrice: "0.02" })),
  })
  const invoice = await prisma.invoice.create({ data: { organizationId, contactId: contact.id, number: "INV-A2B-BROWSER", status: "draft", supplyDate: new Date("2099-01-01"),
    dueDate: new Date("2026-12-01"), currency: "DKK", countryCode: "DK", locale: "en-US", calculationVersion: "v2",
    subtotalNet: priced.subtotalNet, totalTax: priced.totalTax, totalGross: priced.totalGross,
    sellerSnapshot: { companyName: "Frozen Seller", companyAddress: "Seller Road 1\n9000 Aalborg", taxIds: [{ scheme: "cvr", value: "12345678" }] },
    items: { create: priced.itemRows },
  } })
  await loginAsAdmin(page)
  await page.goto(`/invoices/${invoice.id}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Send without email", exact: true }).click()
  await page.getByRole("button", { name: "Continue without email", exact: true }).click()
  await expect(page.getByRole("button", { name: "Create credit note", exact: true })).toBeVisible()
  for (const [index, tax] of ["0.01", "0.00"].entries()) {
    await page.goto(`/invoices/${invoice.id}`)
    await waitForClientReady(page)
    await page.getByRole("button", { name: "Create credit note", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("radio", { name: "An amount", exact: true }).click()
    await dialog.getByLabel("Amount incl. tax").fill("0.02")
    await dialog.getByLabel("Reason", { exact: true }).fill(`Successive credit ${index + 1}`)
    await expect(dialog).toContainText("DKK")
    await page.screenshot({ path: `${artifacts}/credit-${index + 1}-preview.png`, fullPage: true })
    await dialog.getByRole("button", { name: "Issue credit note", exact: true }).click()
    await page.waitForURL((url) => url.pathname.startsWith("/credit-notes/"))
    await expect(page.getByRole("heading", { name: new RegExp(`Credit note CN-000${index + 1}`) })).toBeVisible()
    const id = new URL(page.url()).pathname.split("/").at(-1)!
    const row = await prisma.creditNote.findUniqueOrThrow({ where: { id } })
    expect(row.totalTax.toFixed(2)).toBe(tax)
    expect(row.totalGross.toFixed(2)).toBe("0.02")
    expect(row.subtotalNet.toFixed(2)).toBe(index === 0 ? "0.01" : "0.02")
    expect(creditedGroupsSchema.parse(row.creditedGroups)[0]!.cumulativeAfter).toBe(index === 0 ? "0.02" : "0.04")
    await expect(page.getByText("Subtotal", { exact: true }).locator("..")).toContainText(index === 0 ? "DKK 0.01" : "DKK 0.02")
    await expect(page.getByText("Successive credit", { exact: false })).toBeVisible()
    await page.screenshot({ path: `${artifacts}/credit-${index + 1}-issued.png`, fullPage: true })
  }
  await page.goto(`/invoices/${invoice.id}`)
  await waitForClientReady(page)
  await expect(page.getByText(/credited/i).first()).toBeVisible()
  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download e-invoice (UBL)", exact: true }).click()
  const download = await downloadPromise
  await download.saveAs(`${artifacts}/invoice-v2.xml`)
  const xml = await readFile(`${artifacts}/invoice-v2.xml`, "utf8")
  expect(xml).toContain('<cbc:TaxAmount currencyID="DKK">0.02</cbc:TaxAmount>')
  expect(xml).toContain('<cbc:PayableAmount currencyID="DKK">0.08</cbc:PayableAmount>')
  await page.screenshot({ path: `${artifacts}/invoice-v2-export.png`, fullPage: true })
  // A legacy document without a stored artifact must refuse rather than rerender live rows.
  const unclassified = await prisma.invoice.create({ data: { organizationId, contactId: contact.id, number: "LEGACY-UNCLASSIFIED", status: "sent",
    dueDate: new Date("2026-12-01"), subtotalNet: "1", totalTax: "0", totalGross: "1", sellerSnapshot: invoice.sellerSnapshot!, currency: "DKK", countryCode: "DK",
    items: { create: [{ description: "Unknown VAT", quantity: "1", unitPriceNet: "1", unitPriceGross: "1", lineNet: "1", lineTax: "0", lineGross: "1", taxRate: "0", vatTreatment: "unclassified_zero" }] },
  } })
  await page.goto(`/invoices/${unclassified.id}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Download e-invoice (UBL)", exact: true }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Stored UBL artifact unavailable" })).toBeVisible()
  await page.screenshot({ path: `${artifacts}/unclassified-refusal.png`, fullPage: true })
})
