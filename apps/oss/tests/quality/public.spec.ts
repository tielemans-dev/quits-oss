import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { renderToBuffer } from '@react-pdf/renderer'
import { prisma } from '../../src/lib/db'
import { appRouter } from '../../src/trpc/router'
import { bootstrapQuitsRuntime, resetQuitsRuntimeForTests } from '../../src/lib/runtime/bootstrap'
import { InvoicePdfDocument, type InvoiceForPdf } from '../../src/lib/invoice-pdf'
import { CreditNotePdfDocument } from '../../src/lib/credit-note-pdf'
import { buildInvoiceEmailContent } from '../../src/lib/email'
import { buildCreditNoteEmailContent } from '../../src/lib/emails/credit-note-email'
import { danishLocale, usEnglishLocale, resetDatabase, seedPublicQuote, seedPublicInvoice, loginAsAdmin, waitForClientReady } from '../e2e/support'

test.beforeEach(async ({ page, baseURL }) => {
  // Block external browser requests, including payment providers and remote images.
  await page.route('**/*', route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort())
  await page.clock.setFixedTime(new Date('2026-10-15T12:00:00Z'))
})
test.afterEach(() => resetQuitsRuntimeForTests())

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready)
  const png = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' })
  await info.attach(name, { body: png, contentType: 'image/png' })
  expect.soft(png).toMatchSnapshot(`${name}.png`, { maxDiffPixelRatio: 0.001 })
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  await info.attach(`${name}-axe`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
  expect.soft(results.violations, `${name}: axe violations`).toEqual([])
}

for (const locale of [danishLocale, usEnglishLocale]) {
  for (const width of [1440, 390]) {
    test(`recipient and app pages ${locale.locale} ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await resetDatabase()
      const quote = await seedPublicQuote({ locale })
      await prisma.quote.update({ where: { id: quote.id }, data: { expiryDate: new Date('2099-01-01') } })
      await page.goto(quote.url)
      await waitForClientReady(page)
      await expect(page.getByText(quote.number).first()).toBeVisible()
      await capture(page, info, 'quote')

      const row = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })
      await prisma.orgSettings.update({ where: { organizationId: row.organizationId }, data: { momsRegistered: true } })
      const member = await prisma.member.findFirstOrThrow({ where: { organizationId: row.organizationId } })
      // Synthetic storage isolates issuance. PDF visuals below use the real renderers.
      const objects = new Map<string, Uint8Array>()
      bootstrapQuitsRuntime({ services: {
        documentRenderer: { version: 'quality-fixture', async renderPdf() { return new TextEncoder().encode('%PDF-synthetic') } },
        documentArtifactStore: {
          async put(bytes, meta) { objects.set(meta.hash, bytes); return meta.hash },
          async get(ref) { return objects.get(ref) ?? null }, async head() { return null }, async delete(ref) { objects.delete(ref) },
        },
      } })
      const caller = appRouter.createCaller({ session: {
        user: { id: member.userId, email: 'admin@e2e.example', name: 'E2E Admin' },
        session: { activeOrganizationId: row.organizationId },
      } } as never)
      const agreement = await caller.agreements.createDraft({ contactId: row.contactId!, title: 'Quality fixture',
        termsMarkdown: 'Synthetic project terms.', validUntil: '2099-01-01', taxRate: locale.countryCode === 'DK' ? 25 : 0,
        deliverables: [{ title: 'Design', quantity: 1, unitPrice: 100 }] })
      await caller.agreements.issue({ id: agreement.id })
      const link = await caller.agreements.publicLink({ id: agreement.id })
      expect(link).toBeTruthy()
      await page.goto(link!.url)
      await waitForClientReady(page)
      await expect(page.getByText('Quality fixture').first()).toBeVisible()
      await capture(page, info, 'agreement')

      await resetDatabase()
      const invoice = await seedPublicInvoice({ locale })
      const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      // Bank-only payment fixture. No Stripe API requests or provider credentials.
      await prisma.orgSettings.update({ where: { organizationId: issued.organizationId }, data: {
        stripePublishableKey: null, stripeSecretKeyEnc: null, stripeWebhookSecretEnc: null,
      } })
      await prisma.invoice.update({ where: { id: invoice.id }, data: {
        dueDate: new Date('2099-01-01'), sellerSnapshot: { companyName: 'E2E Org', bankAccount: { regNumber: '0040', accountNumber: '0440116243' } },
      } })
      await page.goto(invoice.url)
      await waitForClientReady(page)
      await expect(page.getByText(invoice.number).first()).toBeVisible()
      await capture(page, info, 'payment')
      await loginAsAdmin(page)
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate(value => localStorage.setItem('quits-theme', value), theme)
        await page.emulateMedia({ colorScheme: theme })
        await page.goto(`/invoices/${invoice.id}`)
        await waitForClientReady(page)
        await expect(page.getByRole('heading', { name: new RegExp(invoice.number) })).toBeVisible()
        await capture(page, info, `app-${theme}`)
      }
    })

    test(`document output ${locale.locale} ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      const org = { companyName: 'Quality Studio', companyEmail: 'billing@example.test', locale: locale.locale, timezone: 'UTC' }
      const invoice: InvoiceForPdf = { number: 'INV-0001', status: 'sent', issueDate: '2026-10-15', dueDate: '2026-10-29',
        subtotal: 1000, taxAmount: 250, total: 1250, currency: 'DKK', notes: null,
        contact: { name: 'Test customer', email: 'customer@example.test' },
        items: [{ description: 'Design', quantity: 1, unitPrice: 1000, total: 1000 }],
      }
      const creditNote = { ...invoice, number: 'CN-0001', reason: 'Test correction', invoice }
      for (const [name, content] of [
        ['invoice-email', buildInvoiceEmailContent({ invoice, org, contactName: invoice.contact.name })],
        ['credit-email', buildCreditNoteEmailContent({ creditNote, invoice, org, contactName: invoice.contact.name })],
      ] as const) {
        await page.setContent(content.html)
        await capture(page, info, name)
      }
      if (width === 1440) {
        for (const [name, document] of [
          ['invoice', InvoicePdfDocument({ invoice, org })],
          ['credit-note', CreditNotePdfDocument({ creditNote, org })],
        ] as const) {
          const pdf = await renderToBuffer(document)
          const path = info.outputPath(`${name}.pdf`)
          await writeFile(path, pdf)
          await info.attach(name, { path, contentType: 'application/pdf' })
          execFileSync('pdftoppm', ['-png', '-r', '96', path, info.outputPath(name)])
          for (const file of (await readdir(info.outputDir)).filter(file => file.startsWith(`${name}-`) && file.endsWith('.png')).sort()) {
            const png = await readFile(info.outputPath(file))
            await info.attach(file, { body: png, contentType: 'image/png' })
            expect.soft(png).toMatchSnapshot(file, { maxDiffPixelRatio: 0.001 })
          }
        }
      }
    })
  }
}
