import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { loginAsAdmin, resetDatabase, seedCompletedSetup, waitForClientReady } from "./support"

// Actual application, real authentication and RPCs. Synthetic account in disposable CI PostgreSQL.
// No mocked DOM, server responses, or production data. Locale is set explicitly after verifying
// the absent-settings onboarding path, to capture both supported UI languages independently.
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
    provenance: "Real OSS app in cloud distribution, disposable CI PostgreSQL, synthetic setup admin, real login and onboarding RPCs. Saved locale override only after asserting fresh Danish defaults. V2 capability disabled; legacy manual onboarding shown.",
    images,
  }, null, 2))
})

for (const locale of ["da-DK", "en-US"]) {
  for (const width of [390, 1440]) {
    test(`${locale} onboarding at ${width}px`, async ({ browser }) => {
      await resetDatabase()
      const setup = await seedCompletedSetup()
      await prisma.organization.update({ where: { id: setup.organizationId }, data: { subscriptionStatus: "pro" } })
      // Remove installation defaults: exercise onboarding's actual first-read creation.
      await prisma.orgSettings.delete({ where: { organizationId: setup.organizationId } })
      const context = await browser.newContext({ locale, viewport: { width, height: 1000 } })
      try {
        const page = await context.newPage()
        await loginAsAdmin(page)
        await expect(page).toHaveURL(/\/onboarding/)
        await expect(page.getByLabel("Country", { exact: true })).toHaveValue("DK")
        await expect(page.getByLabel("Default currency")).toHaveValue("DKK")
        await expect(page.getByLabel("Tax setup")).toHaveValue("eu_vat")
        const initial = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: setup.organizationId } })
        expect(initial).toMatchObject({ countryCode: "DK", defaultCurrency: "DKK", baseCurrency: "DKK", currency: "DKK", taxRegime: "eu_vat" })
        await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { locale } })
        await page.reload()
        await waitForClientReady(page)
        await expect(page.locator("html")).toHaveAttribute("lang", locale.startsWith("da") ? "da" : "en")
        await expect(page.getByLabel("Country", { exact: true })).toHaveValue("DK")
        await expect(page.getByLabel("Default currency")).toHaveValue("DKK")
        await expect(page.getByLabel("Tax setup")).toHaveValue("eu_vat")
        await expect(page.getByRole("alert")).toHaveCount(0)
        const capture = async (state: string) => {
          const file = `${locale}-${width}-${state}.png`
          await mkdir(captureDir!, { recursive: true })
          await page.screenshot({ path: resolve(captureDir!, file), fullPage: true })
          images.push({ file, locale, width, state, url: page.url(), countryCode: "DK", defaultCurrency: "DKK", taxRegime: "eu_vat", validation: state === "invalid-submit" ? message : null })
        }
        const message = locale.startsWith("da")
          ? "Udfyld virksomhedsnavn, adresse og e-mail for at fortsætte."
          : "Fill in company name, address and email to continue."
        await capture("fresh-initial")
        await page.getByLabel("Company name").fill("Synthetic Onboarding ApS")
        await expect(page.getByRole("alert")).toHaveCount(0)
        await page.getByRole("button", { name: "Finish onboarding", exact: true }).click()
        await expect(page.getByRole("alert")).toHaveText(message)
        await capture("invalid-submit")
        await page.getByLabel("Company address").fill("Example street 1, 1000 Copenhagen")
        await page.getByLabel("Billing email").fill("billing@example.test")
        await page.getByLabel("VAT/CVR number").fill("24256790")
        await expect(page.getByRole("alert")).toHaveCount(0)
        await page.getByRole("button", { name: "Finish onboarding", exact: true }).click()
        await page.waitForURL(url => url.pathname === "/")
        const completed = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: setup.organizationId } })
        expect(completed).toMatchObject({ onboardingStatus: "complete", countryCode: "DK", defaultCurrency: "DKK", taxRegime: "eu_vat", locale })
      } finally {
        await context.close()
      }
    })
  }
}
