import { expect, test } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import {
  danishLocale,
  resetDatabase,
  seedCompletedSetup,
  seedPublicInvoice,
  tinyLogoDataUrl,
  waitForClientReady,
} from "./support"

test.beforeEach(async () => {
  await resetDatabase()
})

test("renders a public invoice payment page with checkout available", async ({ page }) => {
  const invoice = await seedPublicInvoice()

  await page.goto(invoice.url)
  await waitForClientReady(page)

  await expect(page.getByText(invoice.number)).toBeVisible()
  await expect(page.getByRole("button", { name: "Pay now" })).toBeVisible()
  await expect(page.getByText("Invoice from E2E Org")).toBeVisible()
})

test("keeps the payment link of an invoice credited in full, without a payment button", async ({ page }) => {
  const invoice = await seedPublicInvoice()
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: "credited", amountCredited: "250.00" },
  })

  await page.goto(invoice.url)
  await waitForClientReady(page)

  await expect(page.getByText(invoice.number)).toBeVisible()
  await expect(page.getByText("Invoice credited")).toBeVisible()
  await expect(page.getByText("This invoice has been credited in full. Nothing is due.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Pay now" })).toHaveCount(0)
})

test("presents the invoice in Danish, with kroner and the seller's logo, when the seller is Danish", async ({
  page,
}) => {
  const invoice = await seedPublicInvoice({
    locale: danishLocale,
    total: "1250.00",
    companyLogo: tinyLogoDataUrl,
  })

  await page.goto(invoice.url)
  await waitForClientReady(page)

  await expect(page.getByText("Faktura fra E2E Org")).toBeVisible()
  await expect(page.getByText("Betal denne faktura")).toBeVisible()
  await expect(page.getByRole("button", { name: "Betal nu" })).toBeVisible()
  await expect(page.getByText("Afventer betaling")).toBeVisible()
  await expect(page.getByText("Fakturadato")).toBeVisible()
  await expect(page.getByText("Forfaldsdato")).toBeVisible()
  await expect(page.getByText("Til betaling")).toBeVisible()
  await expect(page.getByText(/^1\.250,00\s*kr\.$/).first()).toBeVisible()
  await expect(page.getByText("9. mar. 2026")).toBeVisible()
  await expect(page.getByText("23. mar. 2026")).toBeVisible()
  await expect(page.locator("[lang=da]").first()).toBeVisible()

  // The seller's logo and name head the page; the product's name appears nowhere.
  await expect(page.locator("header img")).toHaveAttribute("src", tinyLogoDataUrl)
  await expect(page.locator("header").getByText("E2E Org")).toBeVisible()
  await expect(page.getByText("Pay now")).toHaveCount(0)
  await expect(page.getByText("Quits")).toHaveCount(0)
  await expect(page).toHaveTitle("Faktura INV-E2E-0001 · E2E Org")
})

test("keeps the document's language whatever the visitor's browser prefers", async ({ browser }) => {
  const danish = await seedPublicInvoice({ locale: danishLocale, total: "1250.00" })
  const hydrationProblems: string[] = []

  // A Danish invoice opened in an English browser.
  const english = await browser.newContext({ locale: "en-GB" })
  const englishPage = await english.newPage()
  englishPage.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) {
      hydrationProblems.push(message.text())
    }
  })
  await englishPage.goto(danish.url)
  await waitForClientReady(englishPage)
  await expect(englishPage.getByRole("button", { name: "Betal nu" })).toBeVisible()
  await expect(englishPage.getByText(/^1\.250,00\s*kr\.$/).first()).toBeVisible()
  await english.close()

  // An English invoice opened in a Danish browser.
  await resetDatabase()
  const us = await seedPublicInvoice()
  const danishBrowser = await browser.newContext({ locale: "da-DK" })
  const danishPage = await danishBrowser.newPage()
  danishPage.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) {
      hydrationProblems.push(message.text())
    }
  })
  await danishPage.goto(us.url)
  await waitForClientReady(danishPage)
  await expect(danishPage.getByRole("button", { name: "Pay now" })).toBeVisible()
  await expect(danishPage.getByText("$250.00").first()).toBeVisible()
  await danishBrowser.close()

  expect(hydrationProblems).toEqual([])
})

test("answers an invalid link in the visitor's language, as there is no document to take one from", async ({
  browser,
}) => {
  await seedCompletedSetup()
  const danish = await browser.newContext({ locale: "da-DK" })
  const danishPage = await danish.newPage()
  await danishPage.goto("/pay/not-a-real-token")
  await expect(danishPage.getByText("Dette betalingslink er ugyldigt eller udløbet.")).toBeVisible()
  await danish.close()

  const english = await browser.newContext({ locale: "en-US" })
  const englishPage = await english.newPage()
  await englishPage.goto("/pay/not-a-real-token")
  await expect(englishPage.getByText("This invoice payment link is invalid or has expired.")).toBeVisible()
  await english.close()
})
