import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { danishLocale, loginAsAdmin, resetDatabase, seedPublicQuote, usEnglishLocale, waitForClientReady } from "./support"

const stage = process.env.QUI64_SCREENSHOT_STAGE
const directory = resolve(import.meta.dirname, "../../../../.github/assets/qui64")

for (const locale of [usEnglishLocale, danishLocale]) {
  test(`QUI-64 screenshots ${locale.locale}`, async ({ page }) => {
    test.setTimeout(120_000)
    test.skip(!stage, "Run with QUI64_SCREENSHOT_STAGE=before or after for review evidence")
    await resetDatabase()
    await mkdir(directory, { recursive: true })
    const seeded = await seedPublicQuote({ locale, total: "1250.00" })
    const quote = await prisma.quote.update({ where: { id: seeded.id }, data: { subtotalNet: "1000", totalTax: "250" } })
    await prisma.quoteItem.updateMany({ where: { quoteId: quote.id }, data: {
      quantity: "2", unitPriceNet: "500", unitPriceGross: "625", lineNet: "1000", lineTax: "250", lineGross: "1250", taxRate: "25",
    } })
    // MOCK: local screenshot fixtures only. They are never loaded by application runtime.
    const invoice = await prisma.invoice.create({ data: {
      organizationId: quote.organizationId, contactId: quote.contactId, number: "INV-0001", status: "credited",
      dueDate: new Date("2099-01-01"), subtotalNet: "100", totalTax: "25", totalGross: "125", amountCredited: "125",
      currency: locale.currency, locale: locale.locale, timezone: locale.timezone, countryCode: locale.countryCode,
      sellerSnapshot: quote.sellerSnapshot!, buyerSnapshot: quote.buyerSnapshot!,
      items: { create: [{ description: "Credit test work", quantity: "1", unitPriceNet: "100", unitPriceGross: "125",
        lineNet: "100", lineTax: "25", lineGross: "125", taxRate: "25" }] },
    } })
    const credit = await prisma.creditNote.create({ data: {
      id: "doc_qui64_screenshot_credit", organizationId: quote.organizationId, invoiceId: invoice.id, contactId: quote.contactId,
      number: "CN-0001", reason: "Local test correction", subtotalNet: "100", totalTax: "25", totalGross: "125",
      currency: locale.currency, countryCode: locale.countryCode, locale: locale.locale, timezone: locale.timezone,
      taxRegime: quote.taxRegime, sellerSnapshot: quote.sellerSnapshot!, buyerSnapshot: quote.buyerSnapshot!,
      items: { create: [{ description: "Credit test work", quantity: "1", unitPriceNet: "100", unitPriceGross: "125",
        lineNet: "100", lineTax: "25", lineGross: "125", taxRate: "25" }] },
    } })
    // Login uses the initial English login form; app pages use the organization's locale.
    await loginAsAdmin(page)
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await page.evaluate(value => localStorage.setItem("quits-theme", value), theme)
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        for (const [screen, url] of [
          ["quote", seeded.url], ["invoice-credit-row", `/invoices/${invoice.id}`], ["credit-note", `/credit-notes/${credit.id}`],
        ]) {
          await page.goto(url!)
          await waitForClientReady(page)
          await expect(page.getByText(screen === "quote" ? quote.number! : screen === "credit-note" ? /CN-0001/ : "INV-0001").first()).toBeVisible()
          // Public documents intentionally stay light even when the browser prefers dark.
          await page.screenshot({ path: `${directory}/${stage}-${screen}-${locale.locale}-${theme}-${width}.png`, fullPage: true })
        }
      }
    }
  })
}
