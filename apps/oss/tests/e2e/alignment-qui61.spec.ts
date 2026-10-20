import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import issuedFixture from "../../src/domain/events/__tests__/fixtures/invoice.issued.v1.json" with { type: "json" }
import { adminCredentials, danishLocale, resetDatabase, seedPublicInvoice, usEnglishLocale, waitForClientReady } from "./support"

// MOCK: synthetic local/test organizations only. Never imported by application code.
const variant = process.env.QUI61_SCREENSHOTS === "before" ? "before" : "after"
const captureDir = process.env.QUI61_SCREENSHOTS ? resolve(import.meta.dirname, "../../../../.artifacts/qui-61") : null
async function capture(page: Page, name: string) {
  if (!captureDir) return
  await mkdir(captureDir, { recursive: true })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: resolve(captureDir, `${name}-${variant}.png`), fullPage: true })
}
async function searchAligned(page: Page, screen: string) {
  // Overblik has no search in the top bar: its field is the palette itself, centred under the
  // greeting. Everywhere else the search starts where the content does.
  const field = screen === "dashboard" ? page.locator("[data-live-sheet]") : page.getByRole("button", { name: /Open search|Åbn søgning/ })
  const search = await field.boundingBox()
  const content = await page.locator("[data-slot=app-content]").evaluate(el => {
    const box = el.getBoundingClientRect(), style = getComputedStyle(el)
    const left = box.left + parseFloat(style.paddingLeft), right = box.right - parseFloat(style.paddingRight)
    return { left, centre: (left + right) / 2 }
  })
  expect(search).not.toBeNull()
  if (screen === "dashboard") expect(Math.abs(search!.x + search!.width / 2 - content.centre)).toBeLessThanOrEqual(1)
  else expect(Math.abs(search!.x - content.left)).toBeLessThanOrEqual(1)
}
for (const locale of [danishLocale, usEnglishLocale]) {
  test(`QUI-61 alignment in ${locale.locale}`, async ({ browser }) => {
    test.setTimeout(180_000)
    await resetDatabase()
    const seeded = await seedPublicInvoice({ locale, total: "1250.00" })
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: seeded.id } })
    const bankAccount = { accountHolder: "Test Studio ApS", bankName: "Test Bank", regNumber: "0000", accountNumber: "0000000000" }
    await prisma.orgSettings.update({ where: { organizationId: invoice.organizationId }, data: {
      companyName: "Test Studio ApS", companyAddress: "Testvej 1\n1000 København", companyEmail: "seller@example.test", bankAccountHolder: bankAccount.accountHolder, bankName: bankAccount.bankName, bankRegNumber: bankAccount.regNumber, bankAccountNumber: bankAccount.accountNumber,
      stripePublishableKey: null, stripeSecretKeyEnc: null, stripeWebhookSecretEnc: null,
      reminderPolicy: { enabled: true, offsetsDays: [-3, 7, 14] },
    } })
    await prisma.invoice.update({ where: { id: invoice.id }, data: {
      number: "INV-0002", issueDate: new Date("2026-10-11T12:00:00Z"), dueDate: new Date("2026-10-25"),
      subtotalNet: "1000.00", totalTax: "250.00", totalGross: "1250.00",
      sellerSnapshot: { companyName: "Test Studio ApS", companyAddress: "Testvej 1\n1000 København", companyEmail: "seller@example.test", bankAccount },
      buyerSnapshot: { name: "Test Customer", company: "Test Buyer ApS", email: "buyer@example.test", address: "Testvej 2", zip: "9000", city: "Aalborg", country: "DK" },
      items: { updateMany: { where: {}, data: { description: "Design", quantity: "2.00", unitPriceNet: "500.00", unitPriceGross: "625.00", lineNet: "1000.00", lineTax: "250.00", lineGross: "1250.00", taxRate: "25.00" } } },
    } })
    await prisma.domainEvent.create({ data: {
      organizationId: invoice.organizationId, sequence: 1, aggregateType: "invoice", aggregateId: invoice.id,
      type: "invoice.issued", schemaVersion: 1, actorKind: "user",
      actorId: (await prisma.user.findFirstOrThrow({ where: { email: adminCredentials.email } })).id,
      payload: { ...issuedFixture.cases[0]!.payload, number: "INV-0002", documentId: invoice.id }, occurredAt: new Date("2026-10-11T12:00:00Z"),
    } })
    const context = await browser.newContext({ locale: locale.locale, colorScheme: "light", viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    const da = locale.locale === "da-DK"
    for (const route of ["login", "signup"]) {
      await page.goto(`/${route}`)
      await waitForClientReady(page)
      await expect(page.getByRole("button", { name: da ? (route === "login" ? "Log ind" : "Opret konto") : (route === "login" ? "Log in" : "Create account"), exact: true })).toBeVisible()
    }
    const response = await page.request.post("/api/auth/sign-in/email", { data: { email: adminCredentials.email, password: adminCredentials.password }, headers: { origin: new URL(page.url()).origin } })
    expect(response.ok()).toBe(true)
    for (const [screen, url] of [["dashboard", "/"], ["invoice", `/invoices/${invoice.id}`], ["settings", "/settings/payments"]]) {
      await page.goto(url!)
      await waitForClientReady(page)
      await expect(page.locator("[data-slot=app-content]")).toBeVisible()
      if (screen === "dashboard") await expect(page.getByRole("heading", { name: da ? /^God (morgen|formiddag|eftermiddag|aften)/ : /^Good (morning|afternoon|evening)/ })).toBeVisible()
      if (screen === "settings") await expect(page.getByRole("heading", { name: da ? "Betalinger" : "Payments", exact: true })).toBeVisible()
      if (screen === "invoice") await expect(page.getByRole("heading", { name: da ? "Faktura INV-0002" : "Invoice INV-0002", exact: true })).toBeVisible()
      if (variant === "after") await searchAligned(page, screen!)
      if (screen === "invoice" && variant === "after") {
        await expect(page.getByText(da ? "Faktura INV-0002 udstedt" : "Invoice INV-0002 issued", { exact: true })).toBeVisible()
        await expect(page.getByText(da ? "11. okt. 2026" : "Oct 11, 2026", { exact: false }).first()).toBeVisible()
        const email = page.locator("[data-slot=card]").filter({ has: page.getByText(da ? "E-maillevering" : "Email delivery", { exact: true }) }).last()
        expect(await email.locator("[data-slot=card]").count()).toBe(0)
      }
      await capture(page, `${screen}-${locale.locale}-desktop`)
      if (variant === "after") {
        await page.setViewportSize({ width: 390, height: 844 })
        await searchAligned(page, screen!)
        await page.setViewportSize({ width: 1440, height: 1000 })
      }
      if (screen === "settings") {
        const save = page.getByRole("button", { name: da ? "Gem betalingsoplysninger" : "Save payment details", exact: true })
        await expect(save).toBeDisabled()
        await page.getByLabel(da ? "Bank" : "Bank name", { exact: true }).fill("Test Bank edited")
        await expect(save).toBeEnabled()
        expect(await save.getAttribute("data-variant")).toBe("default")
        await capture(page, `settings-edited-${locale.locale}-desktop`)
      }
    }
    await page.goto(seeded.url)
    await waitForClientReady(page)
    if (variant === "after") {
      const cards = page.locator("[data-slot=card]")
      const first = await cards.nth(0).boundingBox(), second = await cards.nth(1).boundingBox()
      expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(1)
      expect(first!.height).toBeLessThan(second!.height)
      const rights = await page.locator("[data-slot=invoice-totals] dd").evaluateAll(els => els.map(el => el.getBoundingClientRect().right))
      expect(Math.max(...rights) - Math.min(...rights)).toBeLessThanOrEqual(1)
      expect(await page.locator("h2").evaluateAll(els => els.every(el => getComputedStyle(el).textTransform === "uppercase"))).toBe(true)
    }
    await capture(page, `pay-${locale.locale}-desktop`)
    await page.setViewportSize({ width: 390, height: 844 })
    await capture(page, `pay-${locale.locale}-mobile`)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await context.close()
  })
}
