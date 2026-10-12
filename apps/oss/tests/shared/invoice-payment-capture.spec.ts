import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { prisma } from '../../src/lib/db'
import { appRouter } from '../../src/trpc/router'
import { bootstrapQuitsRuntime, resetQuitsRuntimeForTests } from '../../src/lib/runtime/bootstrap'
import { resetDatabase, seedCompletedSetup, danishLocale, loginAsAdmin } from '../e2e/support'

// MOCK/TODO: synthetic review data and PDF adapter, confined to this opt-in test
// and a guarded, disposable local database. No runtime or hosted production mock.
const output = process.env.QUI52_CAPTURE_OUTPUT
const mailpit = process.env.QUI52_MAILPIT_URL
if (process.env.QUI52_CHROMIUM) test.use({ launchOptions: { executablePath: process.env.QUI52_CHROMIUM } })
test.skip(!output || !mailpit, 'Opt-in review captures need disposable Mailpit and an output directory')
test.afterEach(() => resetQuitsRuntimeForTests())

for (const locale of ['da-DK', 'en-US']) {
  test(`capture invoice and delivered email in ${locale}`, async ({ page, baseURL }) => {
    test.setTimeout(120_000)
    const database = new URL(process.env.DATABASE_URL!)
    if (baseURL !== 'http://127.0.0.1:4310' || database.hostname !== '127.0.0.1' || database.pathname !== '/quits_e2e' || !mailpit?.startsWith('http://127.0.0.1:')) {
      throw new Error('Review capture requires the disposable local environment')
    }
    await resetDatabase()
    await fetch(`${mailpit}/api/v1/messages`, { method: 'DELETE' })
    const artifacts = new Map<string, Uint8Array>()
    bootstrapQuitsRuntime({ services: {
      documentRenderer: { version: 'MOCK-review-pdf', async renderPdf(input) { return new TextEncoder().encode(JSON.stringify(input)) } },
      documentArtifactStore: {
        async put(bytes, meta) { const ref = `${meta.documentId}/${meta.hash}`; artifacts.set(ref, bytes); return ref },
        async get(ref) { return artifacts.get(ref) ?? null },
        async head() { return null },
        async delete(ref) { artifacts.delete(ref) },
      },
    } })
    const setup = await seedCompletedSetup({ ...danishLocale, locale, currency: locale === "da-DK" ? "DKK" : "USD" })
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: {
      baseCurrency: locale === 'da-DK' ? 'DKK' : 'USD', companyName: 'Issue-time Seller ApS', companyAddress: 'Testvej 42\n9000 Aalborg',
      bankRegNumber: '0040', bankAccountNumber: '0440116243', paymentNote: 'Synthetic issue-time payment note',
    } })
    await prisma.organizationTaxId.create({ data: { organizationId: setup.organizationId, scheme: 'DK_CVR', value: '12345678', countryCode: 'DK', isPrimary: true } })
    const caller = appRouter.createCaller({ session: {
      user: { id: setup.adminUserId, email: 'admin@e2e.example', name: 'E2E Admin' },
      session: { activeOrganizationId: setup.organizationId },
    } } as never)
    const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: 'Invoice Customer', company: 'Invoice Customer LLC', email: 'buyer@example.invalid', country: 'DK' } })
    const draft = await caller.invoices.create({ contactId: contact.id, dueDate: '2099-01-01', taxRate: 0, items: [{ description: 'Implementation sprint', quantity: 1, unitPrice: 250 }] })
    await caller.invoices.send({ id: draft.id, allowSendWithoutEmail: true })
    const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })
    // MOCK: deterministic historical dates/number in this synthetic invoice only.
    const snapshot = issued.issuanceSnapshot as Record<string, unknown>
    await prisma.invoice.update({ where: { id: issued.id }, data: {
      number: 'INV-0042', issueDate: new Date('2026-03-09T12:00:00Z'), dueDate: new Date('2026-03-23'), supplyDate: new Date('2026-03-09'),
      issuanceSnapshot: { ...snapshot, occurredAt: '2026-03-09T12:00:00Z', supplyDate: '2026-03-09', number: 'INV-0042' } as never,
    } })
    await caller.invoices.createPaymentLink({ id: issued.id })
    await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: {
      companyName: 'Changed live seller', companyAddress: 'Changed live address', bankRegNumber: '9999', bankAccountNumber: '99999999', paymentNote: 'Changed live note',
    } })
    await loginAsAdmin(page)
    await page.goto(`/invoices/${issued.id}`)
    await page.getByRole('button', { name: locale === 'da-DK' ? 'Send e-mail igen' : 'Resend email', exact: true }).click()
    let delivered: { HTML: string } | undefined
    await expect.poll(async () => {
      const inbox = await fetch(`${mailpit}/api/v1/messages`).then(response => response.json())
      const latest = inbox.messages?.[0]
      if (!latest) return false
      delivered = await fetch(`${mailpit}/api/v1/message/${latest.ID}`).then(response => response.json())
      return delivered?.HTML?.includes('INV-0042') ?? false
    }, { timeout: 30_000 }).toBe(true)
    await expect(page.getByRole('button', { name: locale === 'da-DK' ? 'Send e-mail igen' : 'Resend email', exact: true })).toBeEnabled()
    const language = locale === 'da-DK' ? 'da' : 'en'
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await page.evaluate(theme => localStorage.setItem('quits-theme', theme), theme)
      for (const [viewport, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
        await page.setViewportSize({ width, height })
        await page.goto(`/invoices/${issued.id}`)
        await expect(page.getByRole('heading', { name: /INV-0042/ })).toBeVisible()
        await page.evaluate(() => document.fonts.ready)
        if (width === 390) {
          for (const button of await page.locator('button:visible').all()) expect(await button.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
        }
        mkdirSync(path.join(output!, theme), { recursive: true })
        await page.screenshot({ path: path.join(output!, theme, `invoice-${language}-${viewport}.png`), fullPage: true })
        await page.setContent(delivered!.HTML)
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({ path: path.join(output!, theme, `email-${language}-${viewport}.png`), fullPage: true })
      }
    }
  })
}
