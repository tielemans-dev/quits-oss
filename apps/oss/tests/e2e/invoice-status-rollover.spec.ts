import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { danishLocale, loginAsAdmin, resetDatabase, seedPublicInvoice, waitForClientReady } from "./support"

// MOCK: a synthetic sent invoice in the disposable database, with the browser clock at its due-day boundary.
test("refreshes the invoice badge at the seller's midnight without reloading", async ({ page }) => {
  await resetDatabase()
  const invoice = await seedPublicInvoice({ locale: { ...danishLocale, locale: "en-US" } })
  await prisma.invoice.update({ where: { id: invoice.id }, data: { dueDate: new Date("2099-01-01T00:00:00Z") } })
  await loginAsAdmin(page)
  await page.goto("/invoices")
  await waitForClientReady(page)
  await page.clock.install({ time: new Date("2099-01-01T22:59:58Z") })
  await page.clock.pauseAt(new Date("2099-01-01T22:59:59Z"))
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Invoice INV-E2E-0001, Invoice Customer", exact: true }) })
  await expect(row.getByText("Sent", { exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("invoice-before-midnight.png"), fullPage: true })
  await page.clock.fastForward(2000)
  await expect(row.getByText("Overdue", { exact: true })).toBeVisible()
  await page.clock.fastForward(500)
  await expect(row.getByText("Sent", { exact: true })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("invoice-after-midnight.png"), fullPage: true })
  expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("sent")
})
