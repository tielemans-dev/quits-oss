import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { adminCredentials, danishLocale, resetDatabase, seedPublicQuote, usEnglishLocale, waitForClientReady } from "./support"

// MOCK: synthetic quotes, invoices and customers in a disposable test database only.
// Screenshot mode is test-only and never imported into production code.
const before = process.env.QUI65_SCREENSHOTS === "before"
const captureDir = process.env.QUI65_CAPTURE_DIR
async function capture(page: Page, name: string) {
  if (!captureDir) return
  await mkdir(captureDir, { recursive: true })
  await page.screenshot({ path: resolve(captureDir, `${name}-${before ? "before" : "after"}.png`), fullPage: true })
}

for (const locale of [danishLocale, usEnglishLocale]) {
  test(`QUI-65 quote pages in ${locale.locale}`, async ({ browser }) => {
    test.setTimeout(180_000)
    // The screenshot runner must explicitly select its disposable database.
    if (captureDir && !process.env.DATABASE_URL?.includes("/qui65")) throw new Error("QUI-65 captures require the dedicated /qui65 test database")
    await resetDatabase()
    const seeded = await seedPublicQuote({ locale, total: "1250.00" })
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: seeded.id } })
    await prisma.contact.update({ where: { id: quote.contactId }, data: { name: "Test Buyer", company: "Test Buyer ApS", address: "Testvej 2", zip: "9000", city: "Aalborg", country: locale.countryCode } })
    await prisma.quote.update({ where: { id: quote.id }, data: { issueDate: new Date("2026-10-11T12:00:00Z"), expiryDate: new Date("2026-10-25"), notes: "Test project scope and delivery terms.", lastEmailAttemptAt: new Date("2026-10-11T12:00:00Z"), lastEmailAttemptOutcome: "sent", lastEmailAttemptCode: "sent", lastEmailAttemptMessage: "Test email delivered" } })
    const invoice = await prisma.invoice.create({ data: { organizationId: quote.organizationId, contactId: quote.contactId, quoteId: quote.id, number: "INV-0002", status: "sent", dueDate: new Date("2026-10-25"), subtotalNet: "1250.00", totalGross: "1250.00", currency: locale.currency, countryCode: locale.countryCode, locale: locale.locale, timezone: locale.timezone } })
    const da = locale.locale === "da-DK"
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({ locale: "en-US", colorScheme: theme, viewport: { width: 1440, height: 1000 } })
      await context.addInitScript(theme => localStorage.setItem("quits-theme", theme), theme)
      const page = await context.newPage()
      await page.goto("/login")
      const signIn = await page.request.post("/api/auth/sign-in/email", { data: { email: adminCredentials.email, password: adminCredentials.password }, headers: { origin: new URL(page.url()).origin } })
      expect(signIn.ok()).toBe(true)
      for (const [viewport, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
        await page.setViewportSize({ width, height })
        const suffix = `${locale.locale}-${theme}-${viewport}`
        await prisma.quote.update({ where: { id: quote.id }, data: { status: "sent", publicDecisionAt: null } })
        await page.goto(seeded.url)
        await waitForClientReady(page)
        await expect(page.getByRole("button", { name: da ? "Acceptér tilbud" : "Accept quote", exact: true })).toBeVisible()
        if (!before) {
          await expect(page.getByText(da ? "11. okt. 2026" : "11 Oct 2026", { exact: true })).toBeVisible()
          if (viewport === "desktop") {
            const cards = page.locator('[data-slot="card"]')
            const first = await cards.nth(0).boundingBox(), second = await cards.nth(1).boundingBox()
            expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(1)
            expect(Math.abs(first!.height - second!.height)).toBeGreaterThan(10)
          }
          expect(await page.locator("h2, label").evaluateAll(els => els.every(el => getComputedStyle(el).textTransform === "uppercase"))).toBe(true)
        }
        await capture(page, `public-pending-${suffix}`)
        await page.getByRole("button", { name: da ? "Acceptér tilbud" : "Accept quote", exact: true }).click()
        await expect(page.getByText(da ? "Tilbud accepteret" : "Quote accepted", { exact: true })).toBeVisible()
        if (!before) await expect(page.getByText(da ? /^Du accepterede tilbuddet den/ : /^You accepted the quote on/)).toBeVisible()
        await capture(page, `public-accepted-${suffix}`)
        for (const number of ["INV-0002", null]) {
          await prisma.invoice.update({ where: { id: invoice.id }, data: { number, status: number ? "sent" : "draft" } })
          const response = await page.goto(`/quotes/${quote.id}`)
          await waitForClientReady(page)
          await expect(page.getByRole("heading", { name: `${da ? "Tilbud" : "Quote"} ${seeded.number}`, exact: true })).toBeVisible()
          if (!before) {
            const banner = number ? (da ? "Faktureret som INV-0002" : "Invoiced as INV-0002") : (da ? "Faktureret som kladde" : "Invoiced as a draft")
            await expect(page.getByRole("link", { name: banner, exact: true })).toHaveAttribute("href", `/invoices/${invoice.id}`)
            expect(await page.locator('[data-slot="card"] [data-slot="card"]').count()).toBe(0)
            if (da) {
              await expect(page.getByText("9000 Aalborg", { exact: true })).toBeVisible()
              expect(await response!.text()).not.toContain(">Invoices<")
            }
          }
          await capture(page, `admin-${number ? "invoiced" : "draft-invoice"}-${suffix}`)
        }
        await page.goto("/quotes")
        await waitForClientReady(page)
        await expect(page.getByRole("heading", { name: da ? "Tilbud" : "Quotes", exact: true })).toBeVisible()
        await capture(page, `quote-list-${suffix}`)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      }
      await context.close()
    }
  })
}
