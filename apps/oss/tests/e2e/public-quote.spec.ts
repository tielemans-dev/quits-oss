import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
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
  await expect(page.getByText("Mar 23, 2026")).toBeVisible()
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
  await expect(page.getByText(/^Dit svar blev registreret den \d{1,2}\. \w+\.? \d{4}\.$/)).toBeVisible()
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
