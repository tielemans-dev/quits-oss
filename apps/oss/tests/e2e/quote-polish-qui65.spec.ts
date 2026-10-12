import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { prisma } from "../../src/lib/db"
import { danishLocale, loginAsAdmin, resetDatabase, seedPublicQuote, usEnglishLocale, waitForClientReady } from "./support"

// MOCK: synthetic quotes, invoices and customers in a disposable test database only.
// Screenshot mode is test-only and never imported into production code.
const before = process.env.QUI65_SCREENSHOTS === "before"
const captureDir = process.env.QUI65_CAPTURE_DIR
if (process.env.QUI65_EVIDENCE === "true" && (!process.env.CI || !captureDir)) {
  throw new Error("QUI-65 evidence requires CI and an explicit capture directory")
}
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
    // MOCK: all registered quote/credit events, plus invoice crediting, for localization evidence.
    const activityTypes = ["quote.draft_created", "quote.draft_updated", "quote.draft_deleted", "quote.sent", "quote.email_resent", "quote.accepted", "quote.rejected", "quote.converted", "credit_note.issued", "credit_note.sent", "invoice.credited"]
    // Reserve fixture sequences through the same counter as real commands, atomically with
    // insertion. Raw max(sequence)+1 inserts leave the allocator behind and make acceptance
    // roll back on the unique organization/sequence constraint in both main and head.
    await prisma.$transaction(async tx => {
      const { eventSequence: last } = await tx.orgSettings.update({
        where: { organizationId: quote.organizationId },
        data: { eventSequence: { increment: activityTypes.length } },
        select: { eventSequence: true },
      })
      await tx.domainEvent.createMany({ data: activityTypes.map((type, index) => ({
        organizationId: quote.organizationId, sequence: last - activityTypes.length + index + 1,
        aggregateType: type.startsWith("quote.") ? "quote" : type.startsWith("credit_note.") ? "credit_note" : "invoice",
        aggregateId: type.startsWith("quote.") ? quote.id : invoice.id, type,
        payload: { number: type.startsWith("quote.") ? seeded.number : type.startsWith("credit_note.") ? "CN-0001" : "INV-0002", invoiceNumber: "INV-0002", creditNoteNumber: "CN-0001", recipient: "buyer@e2e.example" },
        actorKind: "system", actorLabel: "MOCK test fixture", occurredAt: new Date("2026-10-11T12:00:00Z"),
      })) })
    })
    const fixtureSequence = await prisma.domainEvent.aggregate({ where: { organizationId: quote.organizationId }, _max: { sequence: true } })
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: quote.organizationId } })).eventSequence).toBe(fixtureSequence._max.sequence)
    const da = locale.locale === "da-DK"
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({ locale: "en-US", colorScheme: theme, viewport: { width: 1440, height: 1000 } })
      await context.addInitScript(theme => localStorage.setItem("quits-theme", theme), theme)
      const page = await context.newPage()
      // The login UI selects the admin's organization before loading the app. Signing in
      // through the API alone leaves activeOrganizationId unset and redirects to onboarding.
      await loginAsAdmin(page)
      const session = await page.request.get("/api/auth/get-session")
      expect(session.ok()).toBe(true)
      expect(await session.json()).toMatchObject({ session: { activeOrganizationId: quote.organizationId } })
      // Assert the raw response before any public-decision scenario can fail. Hydrated DOM
      // language alone would conceal a wrong server declaration.
      if (!before) {
        const response = await page.request.get("/quotes")
        expect(response.ok()).toBe(true)
        const html = await response.text()
        expect(html.match(/<html\b[^>]*\blang="([^"]+)"/)?.[1]).toBe(da ? "da" : "en")
        expect(html).toContain(da ? ">Fakturaer<" : ">Invoices<")
        expect(html).not.toContain(da ? ">Invoices<" : ">Fakturaer<")
      }
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
        const sequenceBeforeDecision = (await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: quote.organizationId } })).eventSequence
        const decisionResponse = page.waitForResponse(response => response.url().includes("/_serverFn/") && response.request().method() === "POST")
        await page.getByRole("button", { name: da ? "Acceptér tilbud" : "Accept quote", exact: true }).click()
        expect((await decisionResponse).ok()).toBe(true)
        await expect(page.getByText(da ? "Tilbud accepteret" : "Quote accepted", { exact: true })).toBeVisible()
        const decidedQuote = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })
        expect(decidedQuote.status).toBe("accepted")
        expect(decidedQuote.publicDecisionAt).not.toBeNull()
        const decisionEvent = await prisma.domainEvent.findUniqueOrThrow({ where: { organizationId_sequence: { organizationId: quote.organizationId, sequence: sequenceBeforeDecision + 1 } } })
        expect(decisionEvent).toMatchObject({ type: "quote.accepted", aggregateId: quote.id, payload: { number: seeded.number, source: "customer" } })
        expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: quote.organizationId } })).eventSequence).toBe(sequenceBeforeDecision + 1)
        if (!before) await expect(page.getByText(da ? /^Du accepterede tilbuddet den/ : /^You accepted the quote on/)).toBeVisible()
        await capture(page, `public-accepted-${suffix}`)
        for (const number of ["INV-0002", null]) {
          await prisma.invoice.update({ where: { id: invoice.id }, data: { number, status: number ? "sent" : "draft" } })
          const response = await page.goto(`/quotes/${quote.id}`)
          await waitForClientReady(page)
          await expect(page).toHaveURL(new RegExp(`/quotes/${quote.id}$`))
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
        const listResponse = await page.goto("/quotes")
        const serverHtml = await listResponse!.text()
        const serverHtmlLang = serverHtml.match(/<html\b[^>]*\blang="([^"]+)"/)?.[1]
        if (!before) {
          expect(listResponse!.ok()).toBe(true)
          expect(serverHtmlLang).toBe(da ? "da" : "en")
          expect(serverHtml).toContain(da ? ">Fakturaer<" : ">Invoices<")
          expect(serverHtml).not.toContain(da ? ">Invoices<" : ">Fakturaer<")
        }
        await waitForClientReady(page)
        await expect(page.getByRole("heading", { name: da ? "Tilbud" : "Quotes", exact: true })).toBeVisible()
        const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: new RegExp(seeded.number) }) })
        await expect(row).toBeVisible()
        if (!before) {
          // The issue cell is hidden on mobile; the expiry date remains in the compact row.
          await expect(row).toContainText(da ? "11. okt. 2026" : "11 Oct 2026")
          await expect(row).toContainText(da ? "25. okt. 2026" : "25 Oct 2026")
          await expect(row).not.toContainText("Oct 11, 2026")
          await expect(page.locator("html")).toHaveAttribute("lang", da ? "da" : "en")
        }
        await capture(page, `quote-list-${suffix}`)
        await capture(page, `locale-shell-${suffix}`)
        if (captureDir) {
          const phase = before ? "before" : "after"
          const sidebar = await page.locator('[data-slot="sidebar"]').allTextContents()
          const evidence = { locale: locale.locale, browserLocale: "en-US", theme, viewport, width, serverHtmlLang, htmlLang: await page.locator("html").getAttribute("lang"), sidebar, serverHasDanishNavigation: serverHtml.includes(">Fakturaer<"), serverHasEnglishNavigation: serverHtml.includes(">Invoices<") }
          if (!before && da) {
            expect(evidence.serverHasDanishNavigation).toBe(true)
            expect(evidence.serverHasEnglishNavigation).toBe(false)
          }
          await writeFile(resolve(captureDir, `locale-${suffix}-${phase}.json`), JSON.stringify(evidence, null, 2))
          // Only synthetic test HTML is archived; no production session/data is involved.
          await writeFile(resolve(captureDir, `locale-${suffix}-${phase}.html`), serverHtml)
        }
        await page.goto("/activity")
        await waitForClientReady(page)
        if (!before) {
          await expect(page.getByText(da ? `Tilbud ${seeded.number} sendt` : `Quote ${seeded.number} sent`, { exact: true })).toBeVisible()
          await expect(page.getByText(da ? "Kreditnota CN-0001 udstedt" : "Credit note CN-0001 issued", { exact: true })).toBeVisible()
          await expect(page.getByText(da ? "Faktura INV-0002 krediteret med kreditnota CN-0001" : "Invoice INV-0002 credited with credit note CN-0001", { exact: true })).toBeVisible()
        } else {
          // Baseline labels may be untranslated. Wait for actual fixture events without fixing them.
          await expect(page.getByText("MOCK test fixture").first()).toBeVisible()
        }
        await capture(page, `activity-log-${suffix}`)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      }
      await context.close()
    }
  })
}
