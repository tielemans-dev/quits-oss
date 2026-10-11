import { expect, test } from '@playwright/test'
import { prisma } from '../../src/lib/db'
import { appRouter } from '../../src/trpc/router'
import { bootstrapQuitsRuntime, resetQuitsRuntimeForTests } from '../../src/lib/runtime/bootstrap'
import { composeInvoiceEmail } from '../../src/domain/documents/invoice-email'
import { resetDatabase, seedCompletedSetup, danishLocale, loginAsAdmin } from '../e2e/support'

test.afterEach(() => resetQuitsRuntimeForTests())

for (const locale of ['da-DK', 'en-US']) {
  for (const withBank of [true, false]) {
    test(`issued invoice seller and email payment block in ${locale}, bank: ${withBank}`, async ({ page, baseURL }, testInfo) => {
      const database = new URL(process.env.DATABASE_URL!)
      if (baseURL !== 'http://127.0.0.1:4310' || database.hostname !== '127.0.0.1' || database.pathname !== '/quits_e2e') {
        throw new Error('Invoice payment scenarios require the shared disposable environment')
      }
      await resetDatabase()
      const artifacts = new Map<string, Uint8Array>()
      bootstrapQuitsRuntime({ services: {
        documentRenderer: { version: 'payment-block-browser-fixture', async renderPdf(input) { return new TextEncoder().encode(JSON.stringify(input)) } },
        documentArtifactStore: {
          async put(bytes, meta) { const ref = `${meta.documentId}/${meta.hash}`; artifacts.set(ref, bytes); return ref },
          async get(ref) { return artifacts.get(ref) ?? null },
          async head() { return null },
          async delete(ref) { artifacts.delete(ref) },
        },
      } })
      const setup = await seedCompletedSetup({ ...danishLocale, locale })
      await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { companyName: 'Synthetic Seller ApS', companyAddress: 'Testvej 1\n1000 København' } })
      await prisma.organizationTaxId.create({ data: { organizationId: setup.organizationId, scheme: 'DK_CVR', value: '12345678', countryCode: 'DK', isPrimary: true } })
      const caller = appRouter.createCaller({ session: {
        user: { id: setup.adminUserId, email: 'admin@e2e.example', name: 'E2E Admin' },
        session: { activeOrganizationId: setup.organizationId },
      } } as never)
      const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: 'Synthetic buyer', email: 'buyer@example.invalid', country: 'DK' } })
      const draft = await caller.invoices.create({ contactId: contact.id, dueDate: '2099-01-01', taxRate: 25, items: [{ description: 'Synthetic consulting', quantity: 2, unitPrice: 1000 }] })
      // Payment settings change after draft creation. Issuing must copy these values.
      if (withBank) await caller.paymentDetails.update({ bankAccount: { regNumber: '0040', accountNumber: '0440116243' }, note: 'Issue-time payment note' })
      await caller.invoices.send({ id: draft.id, allowSendWithoutEmail: true })
      const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id }, include: { contact: true, items: true } })
      const publicPaymentUrl = withBank ? (await caller.invoices.createPaymentLink({ id: draft.id })).url : null
      await caller.paymentDetails.update({ bankAccount: { regNumber: '1234', accountNumber: '9876543' }, note: 'Changed current payment note' })
      await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { companyName: 'Changed current seller', companyAddress: 'Changed current address' } })
      const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: setup.organizationId } })

      await loginAsAdmin(page)
      await page.goto(`/invoices/${issued.id}`)
      const seller = page.getByRole('region', { name: locale === 'da-DK' ? 'Fra' : 'From', exact: true })
      await expect(seller).toContainText('Synthetic Seller ApS')
      await expect(seller).toContainText('Testvej 1')
      await expect(seller).toContainText('CVR: 12345678')
      await expect(page.getByText(locale === 'da-DK' ? 'Fakturer til' : 'Bill To', { exact: true })).toBeVisible()
      const payment = page.getByRole('region', { name: locale === 'da-DK' ? 'Sådan betaler du' : 'How to pay' })
      if (withBank) {
        await expect(payment).toContainText('0040')
        await expect(payment).toContainText('0440116243')
        await expect(payment).toContainText('Issue-time payment note')
        await expect(payment).toContainText(locale === 'da-DK' ? `Skriv fakturanummer ${issued.number} i beskeden til modtager.` : `Put invoice number ${issued.number} in the payment message.`)
      } else await expect(payment).toHaveCount(0)
      await expect(page.getByText('Changed current payment note')).toHaveCount(0)
      await testInfo.attach('invoice-detail', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
      if (withBank) {
        await page.setViewportSize({ width: 390, height: 844 })
        expect(await payment.evaluate(section => {
          const bounds = section.getBoundingClientRect()
          return bounds.left >= 0 && bounds.right <= window.innerWidth && section.scrollWidth <= section.clientWidth
        })).toBe(true)
      }
      await page.reload()
      await expect(seller).toContainText('Synthetic Seller ApS')
      if (withBank) await expect(payment).toContainText('0440116243')

      // Inspect the same rendered email the outbox composes, without sending to a provider.
      const email = composeInvoiceEmail({ invoice: { ...issued, number: issued.number! }, settings, to: contact.email!, publicPaymentUrl }).message
      await page.setViewportSize({ width: 390, height: 844 })
      await page.setContent(email.html!)
      await expect(page.getByRole('heading', { name: locale === 'da-DK' ? 'Sådan betaler du' : 'How to pay' })).toBeVisible()
      await expect(page.getByText(locale === 'da-DK' ? `Skriv fakturanummer ${issued.number} i beskeden til modtager.` : `Put invoice number ${issued.number} in the payment message.`, { exact: true })).toBeVisible()
      if (withBank) {
        await expect(page.getByText(`${locale === 'da-DK' ? 'Reg.nr.' : 'Reg. no.'}: 0040`, { exact: true })).toBeVisible()
        await expect(page.getByText(`${locale === 'da-DK' ? 'Kontonummer' : 'Account number'}: 0440116243`, { exact: true })).toBeVisible()
        await expect(page.getByRole('link', { name: locale === 'da-DK' ? 'Betal faktura' : 'Pay invoice', exact: true })).toHaveAttribute('href', publicPaymentUrl!)
      } else {
        await expect(page.getByText(/Reg\.nr\.:|Reg\. no\.:|Account number:|Kontonummer:/)).toHaveCount(0)
      }
      await expect(page.getByText('Changed current payment note')).toHaveCount(0)
      await testInfo.attach('invoice-email-mobile', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
    })
  }
}
