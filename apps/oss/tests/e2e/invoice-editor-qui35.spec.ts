import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { adminCredentials, appOrigin, danishLocale, resetDatabase, seedPublicInvoice, usEnglishLocale, waitForClientReady } from "./support"

// Synthetic invoices/customers in the test database, rendered by the real app editor.
// Optional screenshots capture the actual UI, without adapters or DOM substitutions.
for (const locale of [danishLocale, usEnglishLocale]) {
  test(`QUI-35 invoice editor wraps descriptions and rejects exponents in ${locale.locale}`, async ({ browser }) => {
    test.setTimeout(120_000)
    await resetDatabase()
    const seeded = await seedPublicInvoice({ locale })
    await prisma.invoice.update({ where: { id: seeded.id }, data: { status: "draft", number: null, items: { updateMany: { where: {}, data: { taxRate: "25.00", vatTreatment: "standard", vatRateInput: "0.25", vatCountry: locale.countryCode } } } } })
    const context = await browser.newContext({ locale: "en-US", colorScheme: "light", viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    const da = locale.locale === "da-DK"
    const descriptionLabel = da ? "Beskrivelse" : "Description"
    const quantityLabel = da ? "Antal" : "Qty"
    const unitPriceLabel = da ? "Enhedspris" : "Unit Price"
    const assertMobileLabels = async () => {
      const quantity = page.getByRole("textbox", { name: quantityLabel, exact: true })
      const price = page.getByRole("spinbutton", { name: unitPriceLabel, exact: true })
      for (const input of [quantity, price]) {
        const id = await input.getAttribute("id")
        expect(id).toBeTruthy()
        await expect(page.locator(`label[for="${id}"]`)).toBeVisible()
      }
      const total = page.getByRole("status", { name: "Total", exact: true })
      await expect(total).toBeVisible()
      const labelId = await total.getAttribute("aria-labelledby")
      expect(labelId).toBeTruthy()
      await expect(page.locator(`[id="${labelId}"]`)).toBeVisible()
    }
    const invalidMessage = da ? "Eksponentnotation er ikke tilladt." : "Exponent notation is not allowed."
    const description = "A long consulting description that must wrap inside the invoice line item card. ".repeat(3) + "UnbrokenReference".repeat(12)
    const mutations: string[] = []
    page.on("request", request => {
      if (request.method() === "POST" && /invoices\.(updateV2|createV2)/.test(request.url())) mutations.push(request.url())
    })
    try {
      const signIn = await page.request.post("/api/auth/sign-in/email", {
        data: adminCredentials, headers: { origin: new URL(appOrigin).origin },
      })
      expect(signIn.ok()).toBe(true)
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: seeded.id } })
      const activeOrg = await page.request.post("/api/auth/organization/set-active", { data: { organizationId: invoice.organizationId }, headers: { origin: new URL(appOrigin).origin } })
      expect(activeOrg.ok()).toBe(true)
      await page.goto(`/invoices/${seeded.id}`)
      await waitForClientReady(page)
      await page.getByRole("button", { name: da ? "Rediger" : "Edit", exact: true }).click()
      const descriptionInput = page.getByRole("textbox", { name: descriptionLabel, exact: true })
      const quantity = page.getByRole("textbox", { name: quantityLabel, exact: true })
      await assertMobileLabels()
      await descriptionInput.fill(description)
      // Test rendered geometry, including one long unbroken token, rather than CSS class names.
      await expect.poll(() => descriptionInput.evaluate((el: HTMLTextAreaElement) => {
        const row = el.parentElement!
        const card = row.parentElement!
        const rect = el.getBoundingClientRect(), bounds = card.getBoundingClientRect()
        return el.tagName === "TEXTAREA" && el.scrollWidth <= el.clientWidth + 1 &&
          el.scrollHeight <= el.clientHeight + 1 && el.clientHeight > parseFloat(getComputedStyle(el).lineHeight) * 3 &&
          rect.left >= bounds.left && rect.right <= bounds.right && bounds.right <= innerWidth
      })).toBe(true)
      const vatDescription = page.locator('[data-slot="label"]').filter({ hasText: description })
      await expect.poll(() => vatDescription.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      const save = page.getByRole("button", { name: da ? "Gem ændringer" : "Save Changes", exact: true })
      for (const invalid of ["1e3", "1E+3", "1e", "1,5.0", "1.000,5", "1,000,000", "0", "-1", "1000001", "0.1234567", "0,1234567", "1000000,000001"]) {
        await quantity.fill(invalid)
        await save.click()
        await expect(quantity).toHaveValue(invalid)
        await expect(quantity).toHaveAttribute("aria-invalid", "true")
        await expect(page.getByText(invalidMessage, { exact: false })).toBeVisible()
        expect(mutations).toHaveLength(0)
        expect((await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: seeded.id } })).quantityInput).toBeNull()
      }
      await quantity.fill("1e3")
      await save.click()
      if (process.env.QUI35_CAPTURE_DIR) {
        await mkdir(process.env.QUI35_CAPTURE_DIR, { recursive: true })
        await page.screenshot({ path: resolve(process.env.QUI35_CAPTURE_DIR, `invoice-editor-${locale.locale}-390.png`), fullPage: true })
      }
      await quantity.fill(da ? "0,123456" : "0.123456")
      await save.click()
      await expect(page.getByRole("button", { name: da ? "Rediger" : "Edit", exact: true })).toBeVisible()
      const stored = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: seeded.id } })
      expect(stored.description).toBe(description)
      expect(stored.quantityInput).toBe("0.123456")
      expect(mutations).toHaveLength(1)
      await page.reload()
      await page.getByRole("button", { name: da ? "Rediger" : "Edit", exact: true }).click()
      // The stored value is canonical ("0.123456"); the editor shows it with the locale separator.
      await expect(quantity).toHaveValue(da ? "0,123456" : "0.123456")
      await expect(descriptionInput).toHaveValue(description)

      // The create path must also retain the raw notation and refuse to create a draft.
      await page.goto("/invoices/new")
      await waitForClientReady(page)
      await page.getByRole("combobox").filter({ hasText: da ? "Vælg en kunde" : "Select a customer" }).click()
      await page.getByRole("option", { name: "Invoice Customer" }).click()
      await page.locator("#dueDate").click()
      await page.locator("button[data-day]").filter({ hasText: /^15$/ }).first().click()
      await page.keyboard.press("Escape")
      await page.getByRole("textbox", { name: descriptionLabel, exact: true }).fill(description)
      await assertMobileLabels()
      await quantity.fill("1e3")
      await page.getByRole("button", { name: da ? "Gem som kladde" : "Save as Draft", exact: true }).click()
      await expect(page.getByText(invalidMessage, { exact: false })).toBeVisible()
      await expect(quantity).toHaveValue("1e3")
      expect(mutations).toHaveLength(1)
      await quantity.fill(da ? "1,5" : "1.5")
      await page.getByRole("button", { name: da ? "Gem som kladde" : "Save as Draft", exact: true }).click()
      await expect(page).toHaveURL(/\/invoices\/(?!new)[^/]+$/)
      const createdId = new URL(page.url()).pathname.split("/").at(-1)!
      expect((await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: createdId } })).quantityInput).toBe("1.5")
      expect(mutations).toHaveLength(2)
    } finally {
      await context.close()
    }
  })
}
