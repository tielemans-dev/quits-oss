import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { adminCredentials, appOrigin, danishLocale, resetDatabase, seedPublicInvoice, usEnglishLocale, waitForClientReady } from "./support"

for (const locale of [danishLocale, usEnglishLocale]) {
  test(`draft delivery date can be changed and cleared in ${locale.locale}`, async ({ browser }) => {
    test.setTimeout(120_000)
    await resetDatabase()
    const seeded = await seedPublicInvoice({ locale })
    const invoice = await prisma.invoice.update({ where: { id: seeded.id }, data: {
      status: "draft", number: null, supplyDate: new Date("2026-10-05"),
      items: { updateMany: { where: {}, data: { taxRate: "25.00", vatTreatment: "standard", vatRateInput: "0.25", vatCountry: locale.countryCode } } },
    } })
    const context = await browser.newContext({ locale: "en-US", colorScheme: "light", viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    await page.clock.setFixedTime(new Date("2026-10-15T12:00:00Z"))
    const da = locale.locale === "da-DK"
    const edit = page.getByRole("button", { name: da ? "Rediger" : "Edit", exact: true })
    const save = page.getByRole("button", { name: da ? "Gem ændringer" : "Save Changes", exact: true })
    const delivery = page.getByLabel(da ? "Leveringsdato" : "Supply date", { exact: true })
    try {
      expect((await page.request.post("/api/auth/sign-in/email", { data: adminCredentials, headers: { origin: new URL(appOrigin).origin } })).ok()).toBe(true)
      expect((await page.request.post("/api/auth/organization/set-active", { data: { organizationId: invoice.organizationId }, headers: { origin: new URL(appOrigin).origin } })).ok()).toBe(true)
      await page.goto(`/invoices/${invoice.id}`)
      await waitForClientReady(page)
      await edit.click()
      await expect(delivery).toHaveValue(da ? "05.10.2026" : "10/05/2026")
      await delivery.click()
      await page.locator('button[data-day="10/7/2026"]').click()
      await page.keyboard.press("Escape")
      await save.click()
      await expect(edit).toBeVisible()
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).supplyDate?.toISOString()).toBe("2026-10-07T00:00:00.000Z")
      await page.reload()
      await edit.click()
      await expect(delivery).toHaveValue(da ? "07.10.2026" : "10/07/2026")
      await delivery.click()
      await page.getByRole("button", { name: da ? "Ryd" : "Clear", exact: true }).click()
      await page.keyboard.press("Escape")
      await save.click()
      await expect(edit).toBeVisible()
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).supplyDate).toBeNull()
      await page.reload()
      await edit.click()
      await expect(delivery).toHaveValue("")
      await expect(delivery).toHaveAttribute("placeholder", da ? "Vælg en dato" : "Select a date")
    } finally {
      await context.close()
    }
  })
}
