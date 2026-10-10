import { expect, test } from '@playwright/test'
import { prisma } from '../../src/lib/db'
import { appRouter } from '../../src/trpc/router'
import { bootstrapQuitsRuntime, resetQuitsRuntimeForTests } from '../../src/lib/runtime/bootstrap'
import { parseSellerSnapshot } from '@quits/contracts/documents'
import { resetDatabase, seedCompletedSetup, danishLocale } from '../e2e/support'

const holder = 'A'.repeat(120)
const bankName = 'B'.repeat(120)
const note = 'N'.repeat(500)
const reference = `REF-ISSUED-${'R'.repeat(180)}`

test.afterEach(() => resetQuitsRuntimeForTests())

for (const locale of ['da-DK', 'en-US']) {
  for (const viewport of [{ width: 1280, height: 1100 }, { width: 390, height: 844 }]) {
    test(`frozen maximum-length bank details fit ${locale} at ${viewport.width}px`, async ({ page, baseURL }, testInfo) => {
      const database = new URL(process.env.DATABASE_URL!)
      if (baseURL !== 'http://127.0.0.1:4310' || database.hostname !== '127.0.0.1' || database.pathname !== '/quits_e2e') {
        throw new Error('Public bank scenarios require the shared disposable environment')
      }
      await resetDatabase()
      // Issuance uses real commands with synthetic artifact adapters; no email or card provider.
      const artifacts = new Map<string, Uint8Array>()
      bootstrapQuitsRuntime({ services: {
        documentRenderer: { version: 'bank-browser-fixture', async renderPdf(input) { return new TextEncoder().encode(JSON.stringify(input)) } },
        documentArtifactStore: {
          async put(bytes, meta) { const ref = `${meta.documentId}/${meta.hash}`; artifacts.set(ref, bytes); return ref },
          async get(ref) { return artifacts.get(ref) ?? null },
          async head() { return null },
          async delete(ref) { artifacts.delete(ref) },
        },
      } })
      const setup = await seedCompletedSetup({ ...danishLocale, locale })
      await prisma.organizationTaxId.create({ data: { organizationId: setup.organizationId, scheme: 'DK_CVR', value: '12345678', countryCode: 'DK', isPrimary: true } })
      const caller = appRouter.createCaller({ session: {
        user: { id: setup.adminUserId, email: 'admin@e2e.example', name: 'E2E Admin' },
        session: { activeOrganizationId: setup.organizationId },
      } } as never)
      const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: 'Synthetic buyer', email: 'buyer@example.invalid', country: 'DK' } })
      const draft = await caller.invoices.create({ contactId: contact.id, dueDate: '2099-01-01', taxRate: 25, items: [{ description: 'Synthetic consulting', quantity: 2, unitPrice: 1000 }] })
      expect(parseSellerSnapshot(draft.sellerSnapshot)?.bankAccount).toBeFalsy()
      await caller.paymentDetails.update({ bankAccount: { accountHolder: holder, bankName, regNumber: '00 40', accountNumber: '0440-116243', iban: 'dk50 0040 0440 1162 43', bic: 'dabadkkk' }, note })
      // The reference has no public edit command. Set only this synthetic draft value before issuance.
      await prisma.invoice.update({ where: { id: draft.id }, data: { paymentReference: reference } })
      await caller.invoices.send({ id: draft.id, allowSendWithoutEmail: true })
      const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })
      expect(issued.status).toBe('sent')
      expect(issued.paymentReference).toBe(reference)
      expect(parseSellerSnapshot(issued.sellerSnapshot)).toMatchObject({ bankAccount: { accountHolder: holder, bankName, regNumber: '0040', accountNumber: '0440116243' }, paymentNote: note })
      const { url } = await caller.invoices.createPaymentLink({ id: draft.id })
      await caller.paymentDetails.update({ bankAccount: { regNumber: '1234', accountNumber: '9876543' }, note: 'LIVE SETTINGS MUST NOT APPEAR' })
      await testInfo.attach('fixture', { body: JSON.stringify({ url, locale, viewport, invoiceId: draft.id }), contentType: 'application/json' })
      await page.setViewportSize(viewport)
      await page.goto(url)
      const details = page.getByRole('region', { name: locale === 'da-DK' ? 'Betalingsoplysninger' : 'Payment details' })
      await expect(details).toBeVisible()
      for (const value of [holder, bankName, note, reference, '0040', '0440116243', 'DK50 0040 0440 1162 43', 'DABADKKK']) {
        const text = details.getByText(value, { exact: true })
        await expect(text).toBeVisible()
        // Selection preserves the complete value even when its visual lines wrap.
        expect(await text.evaluate(element => {
          const range = document.createRange(); range.selectNodeContents(element)
          return range.toString()
        })).toBe(value)
      }
      await expect(page.getByText('LIVE SETTINGS MUST NOT APPEAR')).toHaveCount(0)
      await expect(page.getByRole('button')).toHaveCount(0)
      const bounds = await details.evaluate(section => {
        const card = section.closest('[data-slot="card"]')!
        const cardBounds = card.getBoundingClientRect()
        const sectionBounds = section.getBoundingClientRect()
        const outside = [...section.querySelectorAll('*')].filter(child => {
          const rect = child.getBoundingClientRect()
          return rect.left < sectionBounds.left - 1 || rect.right > sectionBounds.right + 1 || child.scrollWidth > child.clientWidth + 1
        }).map(child => child.tagName)
        return {
          rootWidth: document.documentElement.scrollWidth, viewport: window.innerWidth,
          outside, sectionInsideCard: sectionBounds.left >= cardBounds.left && sectionBounds.right <= cardBounds.right,
          cardsInsideViewport: [...document.querySelectorAll('[data-slot="card"]')].every(element => {
            const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= window.innerWidth
          }),
          masking: [document.documentElement, document.body, card, section].some(element => ['hidden', 'clip'].includes(getComputedStyle(element).overflowX)),
        }
      })
      await testInfo.attach('bounds', { body: JSON.stringify(bounds), contentType: 'application/json' })
      await testInfo.attach('bank-details', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
      expect(bounds).toMatchObject({ rootWidth: viewport.width, viewport: viewport.width, outside: [], sectionInsideCard: true, cardsInsideViewport: true, masking: false })
      await page.reload()
      await expect(details.getByText(reference, { exact: true })).toBeVisible()
    })
  }
}
