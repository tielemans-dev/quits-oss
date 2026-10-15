import { createServer, type Server } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { expect, test, type Page } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { executeCommand } from "../../src/domain/execute"
import { createInvoiceDraft } from "../../src/domain/commands/invoices"
import { resolveUserActor } from "../../src/domain/user-actor"
import { buildInvoiceEmailContent } from "../../src/lib/email"
import { translate } from "../../src/lib/i18n/translate"
import { resetDatabase, seedCompletedSetup, danishLocale, loginAsAdmin, waitForClientReady } from "./support"

let provider: Server
let delivered = 0
const screenshotDir = process.env.QUI60_SCREENSHOTS_DIR
const baselineURL = process.env.QUI60_BASELINE_ROOT ? "http://127.0.0.1:31460" : undefined
test.beforeAll(async () => {
  provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Synthetic local email only. */ }
    await new Promise(resolve => setTimeout(resolve, 2500))
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ id: `synthetic-qui60-${++delivered}` }))
  })
  await new Promise<void>(resolve => provider.listen(31560, "127.0.0.1", resolve))
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
})
test.afterAll(async () => { await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())) })

async function screenshot(page: Page, name: string) {
  if (!screenshotDir) return
  if (process.env.QUI60_SCREENSHOT_SCOPE === "review" && !name.includes("-review-")) return
  if (name.endsWith("settings-cvr")) {
    await page.locator("#primaryTaxId").locator("xpath=ancestor::*[@data-slot='card'][1]").screenshot({ animations: "disabled", path: `${screenshotDir}/${name}.png` })
  } else if (name.endsWith("bank-preview-toast")) {
    await page.screenshot({ animations: "disabled", path: `${screenshotDir}/${name}.png` })
    await page.getByTestId("payment-details-preview").locator("xpath=ancestor::*[@data-slot='card'][1]").screenshot({ animations: "disabled", style: "header { visibility: hidden !important; }", path: `${screenshotDir}/${name.replace("bank-preview-toast", "bank-details")}.png` })
  } else {
    await page.screenshot({ animations: "disabled", path: `${screenshotDir}/${name}.png`, fullPage: !/confirm-|bank-preview-toast/.test(name) })
  }
}

/** Synthetic adopter response: exercises the extension-driven UI without private hosted code. */
async function readinessPresentation(page: Page, extra: Record<string, unknown>) {
  await page.route("**/api/trpc/**", async route => {
    if (!route.request().url().includes("invoices.sendReadiness")) return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    for (const entry of Array.isArray(body) ? body : [body]) {
      if (entry.result?.data?.json && "standardVatRate" in entry.result.data.json) Object.assign(entry.result.data.json, extra)
    }
    await route.fulfill({ response, json: body })
  })
}

async function fillInvoice(page: Page, da: boolean, after: boolean) {
  await (after ? page.locator("#invoice-contact") : page.getByRole("combobox").first()).click()
  await page.getByRole("option", { name: "Synthetic Buyer" }).click()
  await page.locator("#dueDate").click()
  await page.getByRole("gridcell").filter({ has: page.getByRole("button", { name: /\b20(?:th)?\b/ }) }).first().getByRole("button").click()
  await page.locator('input:not([type="number"]):not([type="date"])').first().fill("Synthetic consulting")
  await page.locator('input[type="number"]').nth(1).fill("1000")
  if (!after) await page.locator('input[type="number"]').last().fill("25")
  await waitForClientReady(page)
  await expect(page.getByRole("button", { name: da ? "Gem og send" : "Save & Send" })).toBeEnabled()
}

for (const language of ["da", "en"] as const) {
  for (const colorScheme of ["light", "dark"] as const) {
  for (const viewport of [{ name: "desktop", width: 1440, height: 1050 }, { name: "mobile", width: 390, height: 844 }]) {
    test(`${language} ${colorScheme} ${viewport.name}: confirmation, redirect, VAT, validation and settings`, async ({ browser }) => {
      await resetDatabase()
      const locale = language === "da" ? "da-DK" : "en-US"
      const da = language === "da"
      const setup = await seedCompletedSetup({ ...danishLocale, locale })
      await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: {
        companyName: "Synthetic Studio ApS", companyAddress: "Testvej 1, 1000 København", taxRate: 25,
        pricesIncludeTax: false, bankRegNumber: "0040", bankAccountNumber: "0440116243", invoiceNextNum: 2,
      } })
      await prisma.organizationTaxId.create({ data: { organizationId: setup.organizationId, scheme: "cvr", value: "12345678", countryCode: "DK", isPrimary: true } })
      const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: "Synthetic Buyer", company: "Synthetic Buyer ApS", email: "buyer@example.test", address: "Testvej 2", zip: "1000", city: "København", country: "DK" } })
      const member = await prisma.member.findFirstOrThrow({ where: { organizationId: setup.organizationId } })
      const actor = await resolveUserActor({ organizationId: setup.organizationId, userId: member.userId })
      if (!actor) throw new Error("Synthetic actor missing")
      const draft = await executeCommand(createInvoiceDraft, { contactId: contact.id, supplyDate: "2026-10-12", dueDate: "2026-11-12", taxRate: 25,
        items: [{ description: "Synthetic consulting", quantity: 1, unitPrice: 1000 }] }, { actor })
      if (draft.status !== "completed") throw new Error("Synthetic draft missing")
      for (const version of baselineURL ? ["before", "after"] : ["after"]) {
        const after = version === "after"
        const context = await browser.newContext({ baseURL: after ? "http://127.0.0.1:31461" : baselineURL!, viewport, colorScheme, locale: "en-US" })
        const page = await context.newPage()
        await loginAsAdmin(page)
        const prefix = `${version}-${language}-${colorScheme}-${viewport.name}`
        await page.goto("/invoices/new")
        await waitForClientReady(page)
        await expect(page.getByRole("button", { name: da ? "Gem og send" : "Save & Send" })).toBeEnabled()
        await screenshot(page, `${prefix}-new-empty`)
        await page.getByRole("button", { name: da ? "Gem og send" : "Save & Send" }).click()
        await screenshot(page, `${prefix}-field-errors`)
        if (after) {
          await expect(page.getByRole("alert").filter({ hasText: da ? "Vælg en kunde" : "Choose a customer" })).toBeVisible()
          await expect(page.getByText(da ? "Udfyld feltet" : "Fill in this field", { exact: true }).first()).toBeVisible()
        }
        await fillInvoice(page, da, after)
        await screenshot(page, `${prefix}-new-invoice`)
        if (after) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (after) {
          // Without a policy-fixed rate the full classification editor stays available.
          const vat = page.getByRole("combobox", { name: da ? "Momsbehandling for linje 1" : "VAT treatment for line 1" })
          await expect(vat).toHaveValue("standard")
          await expect(vat.locator('option[value="intra_community"]')).toHaveCount(1)
          await expect(vat.locator('option[value="export"]')).toHaveCount(1)
          await page.getByRole("radio", { name: da ? "Inkl. moms" : "Incl. VAT" }).click()
          await screenshot(page, `${prefix}-inclusive-prices`)
          await page.getByRole("radio", { name: da ? "Ekskl. moms" : "Excl. VAT" }).click()
          if (viewport.name === "desktop") {
            const positions = await Promise.all(["invoice-contact", "supplyDate", "dueDate"].map(id => page.locator(`label[for="${id}"]`).boundingBox()))
            expect(Math.max(...positions.map(box => box!.y)) - Math.min(...positions.map(box => box!.y))).toBeLessThan(2)
          }
          await page.getByRole("button", { name: da ? "Gem og send" : "Save & Send" }).click()
          await expect(page.getByRole("dialog")).toBeVisible()
          await expect(page.getByRole("heading", { name: da ? "Send faktura?" : "Send invoice?" })).toBeVisible()
          await screenshot(page, `${prefix}-confirm-new`)
          const sentBefore = delivered
          await page.getByRole("dialog").getByRole("button", { name: da ? "Annuller" : "Cancel", exact: true }).click()
          expect(delivered).toBe(sentBefore)
          await page.getByRole("button", { name: da ? "Gem og send" : "Save & Send" }).click()
          const started = Date.now()
          await page.getByRole("dialog").getByRole("button", { name: da ? "Send faktura" : "Send invoice", exact: true }).click()
          await expect(page.getByRole("button", { name: da ? "Sender..." : "Sending..." })).toBeDisabled()
          await page.waitForURL(/\/invoices\/[^/]+$/, { timeout: 10_000 })
          expect(Date.now() - started).toBeLessThan(10_000)
          await expect.poll(() => delivered).toBe(sentBefore + 1)
          expect(await prisma.invoice.count({ where: { organizationId: setup.organizationId } })).toBe(2)
          await screenshot(page, `${prefix}-sent-redirect`)
        }
        await page.goto(`/invoices/${draft.result.id}`)
        await waitForClientReady(page)
        if (!after) await screenshot(page, `${prefix}-confirm-detail`)
        await page.getByRole("button", { name: da ? "Rediger" : "Edit", exact: true }).click()
        await screenshot(page, `${prefix}-draft-editor`)
        await page.getByRole("button", { name: da ? "Annuller" : "Cancel", exact: true }).click()
        if (after) {
          await page.getByRole("button", { name: "Send", exact: true }).click()
          await expect(page.getByRole("dialog")).toBeVisible()
          await screenshot(page, `${prefix}-confirm-detail`)
          await page.getByRole("dialog").getByRole("button", { name: da ? "Annuller" : "Cancel", exact: true }).click()
        }
        for (const path of ["/contacts/new", `/contacts/${contact.id}`]) {
          await page.goto(path)
          await waitForClientReady(page)
          await screenshot(page, `${prefix}-${path.endsWith("new") ? "customer-new" : "customer-edit"}`)
          if (after) {
            await expect(page.locator("#country")).toHaveValue("DK")
            await expect(page.getByText(da ? "Kunder skal være virksomheder." : "Customers must be businesses.")).toBeVisible()
          }
        }
        await page.goto("/settings")
        await waitForClientReady(page)
        await page.locator("#primaryTaxId").scrollIntoViewIfNeeded()
        await screenshot(page, `${prefix}-settings-cvr`)
        if (after) await expect(page.getByLabel(da ? "CVR-nummer" : "CVR number", { exact: true })).toHaveValue("12345678")
        await page.getByLabel(da ? "Bank" : "Bank name", { exact: true }).fill(after ? "Synthetic After Bank" : "Synthetic Bank")
        await page.getByRole("button", { name: da ? "Gem betalingsoplysninger" : "Save payment details", exact: true }).click()
        await expect(page.getByRole("status")).toBeVisible()
        await screenshot(page, `${prefix}-bank-preview-toast`)
        if (after) {
          await expect(page.getByRole("status")).toContainText(da ? "Bankoplysninger gemt" : "Bank details saved")
          await expect(page.getByTestId("payment-details-preview")).toContainText("INV-0003")
          await readinessPresentation(page, { standardVatRate: "25", issues: [] })
          await page.goto("/invoices/new")
          await waitForClientReady(page)
          await expect(page.getByText(da ? "25 % moms" : "25 % VAT", { exact: true })).toBeVisible()
          await expect(page.getByRole("combobox", { name: da ? "Momssats for linje 1" : "VAT rate for line 1" })).toHaveCount(0)
          await fillInvoice(page, da, true)
          await screenshot(page, `${prefix}-hosted-vat`)
          await page.unroute("**/api/trpc/**")
          await readinessPresentation(page, { issues: [{ code: "cvr.invalid", field: "seller.cvr", params: {} }, { code: "seller.bank.required", field: "seller.bankAccount", params: {} }] })
          await page.goto("/invoices/new")
          await waitForClientReady(page)
          await expect(page.getByTestId("organization-gaps")).toHaveCount(1)
          await expect(page.getByTestId("organization-gaps").getByRole("link")).toHaveCount(1)
          await expect(page.getByTestId("organization-gaps")).toContainText(da ? "Fakturaen skal vise dit reg.nr." : "The invoice needs your reg. no.")
          await screenshot(page, `${prefix}-organization-gaps`)
        }
        if (after && viewport.name === "mobile") {
          // MOCK: local synthetic policy outage, never a production readiness override.
          await page.unroute("**/api/trpc/**")
          await page.route("**/api/trpc/**", async route => {
            if (!route.request().url().includes("invoices.sendReadiness")) return route.continue()
            const response = await route.fetch()
            const body = await response.json()
            const paths = new URL(route.request().url()).pathname.split("/api/trpc/")[1].split(",")
            for (const [index, entry] of (Array.isArray(body) ? body : [body]).entries()) {
              if (paths[index] !== "invoices.sendReadiness") continue
              delete entry.result
              entry.error = { json: { message: "Synthetic policy unavailable", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 } } }
            }
            await route.fulfill({ response, json: body })
          })
          await page.goto("/invoices/new")
          // The configured VAT rate and price basis are unknown, so no draft is saved on a guess.
          await expect(page.getByRole("button", { name: da ? "Gem som kladde" : "Save as Draft" })).toBeDisabled()
          await expect(page.getByText(translate("invoiceValidation.unknown", locale), { exact: true })).toBeVisible()
          await screenshot(page, `${prefix}-review-draft-readiness-unavailable`)
          await page.unroute("**/api/trpc/**")
          // MOCK: only the issuance policy is unavailable: drafts stay available, sending asks to retry.
          await page.route("**/api/trpc/**", async route => {
            if (!route.request().url().includes("invoices.sendReadiness")) return route.continue()
            const response = await route.fetch()
            const body = await response.json()
            const paths = new URL(route.request().url()).pathname.split("/api/trpc/")[1].split(",")
            for (const [index, entry] of (Array.isArray(body) ? body : [body]).entries()) {
              if (paths[index] === "invoices.sendReadiness" && entry.result) entry.result.data.json.policyUnavailable = true
            }
            await route.fulfill({ response, json: body })
          })
          await page.goto("/invoices/new")
          await fillInvoice(page, da, true)
          await expect(page.getByRole("button", { name: da ? "Gem som kladde" : "Save as Draft" })).toBeEnabled()
          await page.getByRole("button", { name: da ? "Gem og send" : "Save & Send" }).click()
          await expect(page.getByText(translate("invoiceValidation.policyUnavailable", locale), { exact: true })).toBeVisible()
          await expect(page.getByRole("dialog")).toHaveCount(0)
          await page.unroute("**/api/trpc/**")
          await prisma.contact.update({ where: { id: contact.id }, data: { email: null } })
          const draftsBefore = await prisma.invoice.count({ where: { organizationId: setup.organizationId } })
          await page.goto("/invoices/new")
          await fillInvoice(page, da, true)
          await page.getByRole("button", { name: da ? "Gem og send" : "Save & Send" }).click()
          await expect(page.getByText(translate("invoices.detail.email.fallback.invalidRecipient.title", locale), { exact: true })).toBeVisible()
          await expect(page.getByRole("dialog")).toHaveCount(0)
          expect(await prisma.invoice.count({ where: { organizationId: setup.organizationId } })).toBe(draftsBefore)
          await screenshot(page, `${prefix}-review-recipient-error`)
          await prisma.contact.update({ where: { id: contact.id }, data: { email: "buyer@example.test" } })
          await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { bankRegNumber: null, bankAccountNumber: null } })
          await page.goto(`/invoices/${draft.result.id}`)
          await waitForClientReady(page)
          // Missing bank details are a nudge: the card shows, and sending stays possible.
          await expect(page.getByTestId("organization-gaps")).toBeVisible()
          await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
          await screenshot(page, `${prefix}-review-bank-nudge`)
          await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { bankRegNumber: "0040", bankAccountNumber: "0440116243" } })
          await page.getByRole("button", { name: "Send", exact: true }).click()
          await page.getByRole("dialog").getByRole("button", { name: da ? "Send faktura" : "Send invoice", exact: true }).click()
          await expect.poll(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.result.id } })).lastEmailAttemptOutcome).toBe("sent")
          await expect(page.getByTestId("organization-gaps")).toHaveCount(0)
          await screenshot(page, `${prefix}-review-send-recovered`)
          await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { countryCode: "DE", taxRate: 20 } })
          await page.goto("/invoices/new")
          await fillInvoice(page, da, true)
          const vat = page.getByRole("combobox", { name: da ? "Momsbehandling for linje 1" : "VAT treatment for line 1" })
          await vat.selectOption("exempt")
          await vat.selectOption("standard")
          await expect(vat).toHaveValue("standard")
          await expect(page.getByRole("spinbutton", { name: da ? "Moms" : "Tax" })).toHaveValue("20")
          await screenshot(page, `${prefix}-review-configured-vat`)
          await page.goto("/contacts/new")
          await expect(page.locator("#country")).toHaveValue("DE")
          await screenshot(page, `${prefix}-review-organization-country`)
        }
        if (screenshotDir && viewport.name === "desktop" && colorScheme === "light") {
          const response = await page.request.get(`/api/documents/invoice/${draft.result.id}/pdf`)
          expect(response.status()).toBe(200)
          await writeFile(`${screenshotDir}/${prefix}-country.pdf`, await response.body())
          let buildEmail = buildInvoiceEmailContent
          if (!after) buildEmail = (await import(`${process.env.QUI60_BASELINE_ROOT}/apps/oss/src/lib/email.ts`)).buildInvoiceEmailContent
          const email = buildEmail({ invoice: { number: "INV-0002", issueDate: "2026-10-12", dueDate: "2026-11-12", subtotal: 1000, taxAmount: 250, total: 1250, currency: "DKK", buyer: contact, items: [{ description: "Synthetic consulting", quantity: 1, unitPrice: 1000, total: 1000 }] }, org: { companyName: "Synthetic Studio ApS", locale }, contactName: contact.name })
          await page.setContent(email.html)
          await screenshot(page, `${prefix}-email-country`)
        }
        await context.close()
      }
    })
  }
}

}

// Synthetic local-only journey. The database and local email provider are disposable fixtures.
test("an all-zero draft restores the configured VAT and validates before an unnumbered confirmation", async ({ page }) => {
  await resetDatabase()
  const setup = await seedCompletedSetup({ ...danishLocale, locale: "en-US" })
  await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: {
    companyName: "Synthetic Studio ApS", companyAddress: "Testvej 1, 1000 København", taxRate: 20,
    pricesIncludeTax: false, bankRegNumber: "0040", bankAccountNumber: "0440116243",
  } })
  const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId,
    name: "Synthetic Buyer", company: "Synthetic Buyer ApS", email: "buyer@example.test", country: "DK" } })
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: setup.organizationId } })
  const actor = await resolveUserActor({ organizationId: setup.organizationId, userId: member.userId })
  if (!actor) throw new Error("Synthetic actor missing")
  const result = await executeCommand(createInvoiceDraft, {
    contactId: contact.id, currency: "EUR", supplyDate: "2026-10-12", dueDate: "2026-11-12", taxRate: 0,
    items: [{ description: "Synthetic consulting", quantity: 1, unitPrice: 100, vat: { treatment: "out_of_scope", rate: "0" } }],
  }, { actor })
  if (result.status !== "completed") throw new Error("Synthetic draft missing")
  await loginAsAdmin(page)
  await page.goto(`/invoices/${result.result.id}`)
  await waitForClientReady(page)
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await page.getByLabel("VAT treatment for line 1").selectOption("standard")
  await page.getByRole("button", { name: "Save Changes", exact: true }).click()
  await expect.poll(async () => {
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: result.result.id }, include: { items: true } })
    return [invoice.items[0].taxRate.toString(), invoice.totalTax.toString(), invoice.totalGross.toString()]
  }).toEqual(["20", "20", "120"])
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("alert").first()).toBeVisible()
  await page.locator("#exchangeRate").fill("7.45")
  await page.locator("#rateDate").fill("")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.locator("#rateDate").fill("2026-10-12")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Send invoice?", exact: true })).toBeVisible()
  expect((await prisma.invoice.findUniqueOrThrow({ where: { id: result.result.id } })).status).toBe("draft")
  await screenshot(page, "after-en-light-desktop-review-number-free-confirmation")
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click()
})
