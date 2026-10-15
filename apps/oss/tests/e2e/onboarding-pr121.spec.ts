import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { loginAsAdmin, resetDatabase, seedCompletedSetup, waitForClientReady } from "./support"

// Actual application, real authentication and RPCs. Synthetic account in disposable CI PostgreSQL.
// No mocked DOM, server responses, or production data. Locale is set explicitly after verifying
// the first-read persistence of Danish defaults, to capture both supported UI languages independently.
const captureDir = process.env.ONB121_CAPTURE_DIR
const images: Array<Record<string, unknown>> = []
test.skip(!captureDir, "PR 121 evidence is an explicit CI-only capture")
test.beforeAll(() => {
  if (captureDir && (!process.env.CI || !process.env.ONB121_HEAD)) {
    throw new Error("Onboarding evidence requires CI and exact application head")
  }
})
test.afterAll(async () => {
  if (!captureDir) return
  await mkdir(captureDir, { recursive: true })
  await writeFile(resolve(captureDir, "manifest.json"), JSON.stringify({
    applicationSha: process.env.ONB121_HEAD,
    run: process.env.ONB121_RUN_URL,
    provenance: "Real OSS app in cloud distribution, disposable CI PostgreSQL, synthetic setup admin, real login and onboarding RPCs. First legacy onboarding status RPC read persists Danish defaults, verified before any fixture override. Only the saved locale is then explicitly updated for each language capture. V2 capability disabled; legacy manual onboarding shown. Completion persisted values verified through real RPCs.",
    onboardingMode: "legacy-manual-v2-off",
    initialSettingsPersisted: true,
    localeFixture: "locale-only-override-after-first-read-persistence",
    images,
  }, null, 2))
})

for (const locale of ["da-DK", "en-US"]) {
  for (const width of [390, 1440]) {
    test(`${locale} onboarding at ${width}px`, async ({ browser }) => {
      await resetDatabase()
      const setup = await seedCompletedSetup()
      await prisma.organization.update({ where: { id: setup.organizationId }, data: { subscriptionStatus: "pro" } })
      // Remove installation defaults: the first real legacy status read must persist DK defaults.
      await prisma.orgSettings.delete({ where: { organizationId: setup.organizationId } })
      // The shared login helper uses English labels. The authenticated app's saved locale
      // controls each capture, as in the existing quote evidence harness.
      const context = await browser.newContext({ locale: "en-US", viewport: { width, height: 1000 } })
      try {
        const page = await context.newPage()
        const firstStatusRead = page.waitForResponse(response => response.url().includes("onboarding.getStatus") && response.request().method() === "GET")
        await loginAsAdmin(page)
        expect((await firstStatusRead).ok()).toBe(true)
        await expect(page).toHaveURL(/\/onboarding/)
        // These IDs are linked to the actual labels in the legacy form. Several labels
        // remain English even with html lang="da"; do not invent localized label text.
        const assertDanishDefaults = async () => {
          await expect(page.locator("#countryCode")).toHaveValue("DK")
          await expect(page.locator("#defaultCurrency")).toHaveValue("DKK")
          await expect(page.locator("#taxRegime")).toHaveValue("eu_vat")
        }
        await assertDanishDefaults()
        await expect(page.getByRole("alert")).toHaveCount(0)
        // Await the actual RPC and its committed row before changing only the UI language.
        await expect.poll(async () => {
          const settings = await prisma.orgSettings.findUnique({ where: { organizationId: setup.organizationId } })
          return settings && { ...settings, taxRate: Number(settings.taxRate) }
        }).toMatchObject({
          countryCode: "DK", locale: "da-DK", timezone: "Europe/Copenhagen",
          defaultCurrency: "DKK", baseCurrency: "DKK", currency: "DKK",
          taxRegime: "eu_vat", taxRate: 25, pricesIncludeTax: false, paymentTermsDays: 14,
          invoiceNextNum: 1, quotePrefix: "QTE", quoteNextNum: 1,
          onboardingStatus: "not_started",
        })
        await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { locale } })
        await page.reload()
        await waitForClientReady(page)
        await expect(page.locator("html")).toHaveAttribute("lang", locale.startsWith("da") ? "da" : "en")
        await assertDanishDefaults()
        await expect(page.locator("#locale")).toHaveValue(locale)
        const finish = page.locator('form button[type="submit"]')
        await expect(finish).toHaveAccessibleName("Finish onboarding")
        await expect(finish).toBeEnabled()
        await expect(page.getByRole("alert")).toHaveCount(0)
        const capture = async (state: string) => {
          const file = `${locale}-${width}-${state}.png`
          await mkdir(captureDir!, { recursive: true })
          await page.screenshot({ path: resolve(captureDir!, file), fullPage: true })
          images.push({ file, locale, width, state, url: page.url(), countryCode: "DK", defaultCurrency: "DKK", taxRegime: "eu_vat", validation: state === "invalid-submit" ? message : null })
        }
        const message = locale.startsWith("da")
          ? "Udfyld de markerede felter for at gøre din profil klar til fakturering."
          : "Fill in the marked fields to get your profile ready for invoicing."
        await capture("fresh-initial")
        await page.locator("#companyName").fill("Synthetic Onboarding ApS")
        await expect(page.getByRole("alert")).toHaveCount(0)
        await finish.click()
        await expect(page.getByRole("alert")).toHaveText(message)
        await capture("invalid-submit")
        await page.locator("#companyAddress").fill("Example street 1, 1000 Copenhagen")
        await page.locator("#companyEmail").fill("billing@example.test")
        await page.locator("#primaryTaxId").fill("24256790")
        await expect(page.getByRole("alert")).toHaveCount(0)
        await finish.click()
        await page.waitForURL(url => url.pathname === "/")
        const completed = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: setup.organizationId } })
        expect(completed).toMatchObject({
          onboardingStatus: "complete", onboardingMethod: "manual", countryCode: "DK",
          defaultCurrency: "DKK", baseCurrency: "DKK", currency: "DKK", taxRegime: "eu_vat", locale,
          companyName: "Synthetic Onboarding ApS", companyAddress: "Example street 1, 1000 Copenhagen",
          companyEmail: "billing@example.test",
        })
      } finally {
        await context.close()
      }
    })
  }
}
