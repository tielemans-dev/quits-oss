import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { priceDocumentV2 } from "../../src/domain/documents/pricing"
import { usEnglishLocale } from "./support"
import {
  danishLocale,
  expectLogoServedFromRoute,
  resetDatabase,
  seedCompletedSetup,
  seedPublicQuote,
  tinyLogoDataUrl,
  waitForClientReady,
} from "./support"

test.beforeEach(async () => {
  await resetDatabase()
})

test("allows a customer to accept a public quote", async ({ page }) => {
  const quote = await seedPublicQuote()

  await page.goto(quote.url)
  await waitForClientReady(page)

  await expect(page.getByText(quote.number)).toBeVisible()
  await page.getByRole("button", { name: "Accept quote" }).click()

  await expect(page.getByText("Quote accepted")).toBeVisible()
  await expect
    .poll(async () => {
      const current = await prisma.quote.findUnique({
        where: { id: quote.id },
        select: { status: true },
      })
      return current?.status
    })
    .toBe("accepted")
})

test("shows the quote and its seller in English for an English seller", async ({ page }) => {
  const quote = await seedPublicQuote({ companyLogo: tinyLogoDataUrl })

  await page.goto(quote.url)
  await waitForClientReady(page)

  await expect(page.getByText("Quote from E2E Org")).toBeVisible()
  await expect(page.getByText("$100.00").first()).toBeVisible()
  await expect(page.getByText("23 Mar 2026", { exact: true })).toBeVisible()
  await expectLogoServedFromRoute(page, "q")
  await expect(page.getByText("Quits")).toHaveCount(0)
})

test("presents the quote in Danish, with kroner, and keeps the seller's identity after a decision", async ({
  page,
}) => {
  const quote = await seedPublicQuote({
    locale: danishLocale,
    total: "1250.00",
    companyLogo: tinyLogoDataUrl,
  })

  await page.goto(quote.url)
  await waitForClientReady(page)

  await expect(page.getByText("Tilbud fra E2E Org")).toBeVisible()
  await expect(page.getByText("Gennemgå dette tilbud")).toBeVisible()
  await expect(page.getByText("Afventer svar")).toBeVisible()
  await expect(page.getByText("Tilbudsdato")).toBeVisible()
  await expect(page.getByText("Gyldigt til")).toBeVisible()
  await expect(page.getByText(/^1\.250,00\s*kr\.$/).first()).toBeVisible()
  await expect(page.getByText("9. mar. 2026")).toBeVisible()
  await expect(page.getByText("23. mar. 2026")).toBeVisible()
  await expect(page.getByRole("button", { name: "Afvis tilbud" })).toBeVisible()
  await expect(page.getByText("Accept quote")).toHaveCount(0)
  await expectLogoServedFromRoute(page, "q")
  await expect(page).toHaveTitle("Tilbud QTE-E2E-0001 · E2E Org")

  // The decision answer presents the seller too, and carries the logo's address, not the image.
  const decision = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("_serverFn")
  )
  await page.getByRole("button", { name: "Acceptér tilbud" }).click()
  const decisionBody = await (await decision).text()
  expect(decisionBody).not.toContain("data:image")
  expect(decisionBody).toMatch(/\/q\/[^/]+\/logo/)

  await expect(page.getByText("Tilbud accepteret")).toBeVisible()
  await expect(page.getByText(/^Du accepterede tilbuddet den \d{1,2}\. \w+\.? \d{4}\.$/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Acceptér tilbud" })).toHaveCount(0)
  // The decided page still presents the seller.
  await expectLogoServedFromRoute(page, "q")
  await expect(page.locator("header").getByText("E2E Org")).toBeVisible()
  await expect(page.getByText("Quits")).toHaveCount(0)
})

test("answers 404 on the logo route for a link that is not valid", async ({ page }) => {
  await seedPublicQuote({ companyLogo: tinyLogoDataUrl })

  expect((await page.request.get("/q/not-a-real-token/logo")).status()).toBe(404)
})

test("answers an invalid quote link in the visitor's language", async ({ browser }) => {
  await seedCompletedSetup()
  const danish = await browser.newContext({ locale: "da-DK" })
  const danishPage = await danish.newPage()
  const response = await danishPage.goto("/q/not-a-real-token")
  await expect(danishPage.getByText("Dette tilbudslink er ugyldigt eller udløbet.")).toBeVisible()
  expect(response?.headers()["cache-control"]).toBe("private, no-store")
  const uncompressed = await danishPage.request.get("/q/not-a-real-token", {
    headers: { "Accept-Encoding": "identity" },
  })
  expect(uncompressed.headers()["vary"]).toContain("Accept-Language")
  await danish.close()
})

// Synthetic issued quotes in a disposable test database. No email or payment provider is called.
for (const locale of [danishLocale, usEnglishLocale]) {
  for (const pricesIncludeTax of [false, true]) for (const width of [390, 1440]) {
    test(`${pricesIncludeTax ? "Gross" : "Net"} quote lines remain consistent after acceptance (${locale.locale}, ${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      const seeded = await seedPublicQuote({ locale: { ...locale, currency: "DKK" } })
      const priced = priceDocumentV2({ currency: "DKK", taxRate: "25", pricesIncludeTax, items: [
        { description: "Brand identity", quantity: "1", unitPrice: pricesIncludeTax ? "22500" : "18000" },
        { description: "Website design", quantity: "1", unitPrice: pricesIncludeTax ? "5625" : "4500" },
      ] })
      await prisma.quote.update({ where: { id: seeded.id }, data: {
        pricesIncludeTax, subtotalNet: priced.subtotalNet, totalTax: priced.totalTax, totalGross: priced.totalGross,
        items: { deleteMany: {}, create: priced.itemRows },
      } })
      const stored = await prisma.quote.findUniqueOrThrow({ where: { id: seeded.id }, include: { items: { orderBy: { sortOrder: "asc" } } } })
      await page.goto(seeded.url)
      await waitForClientReady(page)
      const money = (value: number) => new Intl.NumberFormat(locale.locale, { style: "currency", currency: "DKK" }).format(value)
      const summary = page.locator("h2").first().locator("..")
      const assertLines = async () => {
        await expect(summary.getByText(money(pricesIncludeTax ? 22500 : 18000), { exact: true })).toBeVisible()
        await expect(summary.getByText(money(pricesIncludeTax ? 5625 : 4500), { exact: true })).toBeVisible()
        await expect(summary.getByText(money(pricesIncludeTax ? 18000 : 22500), { exact: true })).toHaveCount(0)
        await expect(summary.getByText(money(pricesIncludeTax ? 4500 : 5625), { exact: true })).toHaveCount(0)
        await expect(summary.getByText(`1\u00a0×\u00a0${money(pricesIncludeTax ? 22500 : 18000)}`, { exact: true })).toBeVisible()
        await expect(summary.getByText(`1\u00a0×\u00a0${money(pricesIncludeTax ? 5625 : 4500)}`, { exact: true })).toBeVisible()
        await expect(summary.getByText(locale.locale === "da-DK" ? `Enhedspris ${pricesIncludeTax ? "inkl." : "ekskl."} moms` : `Unit Price ${pricesIncludeTax ? "incl." : "excl."} tax`, { exact: true })).toHaveCount(2)
        await expect(summary.getByText(locale.locale === "da-DK" ? `Beløb ${pricesIncludeTax ? "inkl." : "ekskl."} moms` : `Amount ${pricesIncludeTax ? "incl." : "excl."} tax`, { exact: true })).toHaveCount(2)
        await expect(page.locator('[data-slot="amount"]').nth(2)).toHaveText(money(28125))
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      }
      await assertLines()
      if (process.env.QUI51_SCREENSHOTS) await page.screenshot({ path: `${process.env.QUI51_SCREENSHOTS}/${locale.locale}-${width}-pending.jpg`, type: "jpeg", quality: 75, fullPage: true })
      await page.getByRole("button", { name: locale.locale === "da-DK" ? "Acceptér tilbud" : "Accept quote" }).click()
      await expect(page.getByText(locale.locale === "da-DK" ? "Tilbud accepteret" : "Quote accepted", { exact: true })).toBeVisible()
      await assertLines()
      await page.reload()
      await assertLines()
      const accepted = await prisma.quote.findUniqueOrThrow({ where: { id: seeded.id }, include: { items: { orderBy: { sortOrder: "asc" } } } })
      expect(accepted.status).toBe("accepted")
      expect([accepted.subtotalNet, accepted.totalTax, accepted.totalGross].map(String)).toEqual(["22500", "5625", "28125"])
      expect(accepted.items).toEqual(stored.items)
      if (process.env.QUI51_SCREENSHOTS) await page.screenshot({ path: `${process.env.QUI51_SCREENSHOTS}/${locale.locale}-${width}-accepted.jpg`, type: "jpeg", quality: 75, fullPage: true })
    })
  }
}
