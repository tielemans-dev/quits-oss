import { expect, test } from "@playwright/test"
import { resetDatabase, seedCompletedSetup, seedPublicInvoice, seedPublicQuote } from "./support"

test.beforeEach(async () => { await resetDatabase() })

test("login follows the Full Stop theme and bundles its wordmark", async ({ browser }) => {
  await seedCompletedSetup()
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme })
    const page = await context.newPage()
    await page.goto("/login")
    await expect(page.getByRole("img", { name: "quits" })).toBeVisible()
    await expect.poll(() => page.evaluate(() => ({
      brand: getComputedStyle(document.documentElement).getPropertyValue("--brand").trim(),
      theme: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    }))).toEqual(colorScheme === "dark"
      ? { brand: "#fafaf9", theme: "#0b0b0c" }
      : { brand: "#0b0b0c", theme: "#fafaf9" })
    await context.close()
  }
})

test("recipient documents retain ink controls under a dark browser preference", async ({ browser }) => {
  const quote = await seedPublicQuote()
  for (const url of [quote.url, "/a/invalid-token"]) {
    const context = await browser.newContext({ colorScheme: "dark" })
    const page = await context.newPage()
    await page.goto(url)
    await expect.poll(() => page.evaluate(() => ({
      document: document.documentElement.hasAttribute("data-document"),
      dark: document.documentElement.classList.contains("dark"),
      brand: getComputedStyle(document.documentElement).getPropertyValue("--brand").trim(),
      ring: getComputedStyle(document.documentElement).getPropertyValue("--ring").trim(),
    }))).toEqual({ document: true, dark: false, brand: "#0b0b0c", ring: "#0b0b0c" })
    await context.close()
  }
  await resetDatabase()
  const currentInvoice = await seedPublicInvoice()
  const context = await browser.newContext({ colorScheme: "dark" })
  const page = await context.newPage()
  await page.goto(currentInvoice.url)
  await expect(page.getByRole("button", { name: "Pay now" })).toBeVisible()
  await expect.poll(() => page.evaluate(() => ({
    document: document.documentElement.hasAttribute("data-document"),
    dark: document.documentElement.classList.contains("dark"),
    brand: getComputedStyle(document.documentElement).getPropertyValue("--brand").trim(),
    ring: getComputedStyle(document.documentElement).getPropertyValue("--ring").trim(),
  }))).toEqual({ document: true, dark: false, brand: "#0b0b0c", ring: "#0b0b0c" })
  await context.close()
})
