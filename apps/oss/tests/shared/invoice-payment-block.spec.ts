import { expect, test } from '@playwright/test'
import { prisma } from '../../src/lib/db'
import { appRouter } from '../../src/trpc/router'
import { bootstrapQuitsRuntime, resetQuitsRuntimeForTests } from '../../src/lib/runtime/bootstrap'
import { composeInvoiceEmail } from '../../src/domain/documents/invoice-email'
import { resetDatabase, seedCompletedSetup, danishLocale, loginAsAdmin } from '../e2e/support'

test.afterEach(() => resetQuitsRuntimeForTests())

for (const locale of ['da-DK', 'en-US']) {
  for (const theme of ['light', 'dark'] as const) {
    for (const bankKind of ['domestic', 'iban', null] as const) {
      const withBank = bankKind !== null
      test(`issued invoice seller and email payment block in ${locale}, bank: ${bankKind}, ${theme}`, async ({ page, baseURL }, testInfo) => {
        test.setTimeout(120_000)
        const database = new URL(process.env.DATABASE_URL!)
        if (baseURL !== 'http://127.0.0.1:4310' || database.hostname !== '127.0.0.1' || database.pathname !== '/quits_e2e') {
          throw new Error('Invoice payment scenarios require the shared disposable environment')
        }
        await page.emulateMedia({ colorScheme: theme })
        await page.addInitScript(theme => localStorage.setItem('quits-theme', theme), theme)
        await resetDatabase()
        // MOCK: in-memory PDF/artifact adapters, confined to this disposable browser test.
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
        await caller.paymentDetails.update({ bankAccount: { regNumber: '2222', accountNumber: '2222222222' }, note: 'MOCK creation-time payment note' })
        const draft = await caller.invoices.create({ contactId: contact.id, dueDate: '2099-01-01', taxRate: 25, items: [{ description: 'Synthetic consulting', quantity: 2, unitPrice: 1000 }] })
        // Payment settings change after draft creation. Issuing must copy these values.
        if (withBank) await caller.paymentDetails.update({ bankAccount: bankKind === 'iban' ? { iban: 'DK5000400440116243', bic: 'DABADKKK' } : { regNumber: '0040', accountNumber: '0440116243' }, note: bankKind === 'iban' ? null : 'Issue-time payment note' })
        else await caller.paymentDetails.update({ bankAccount: null, note: null })
        await loginAsAdmin(page)
        await page.goto(`/invoices/${draft.id}`)
        await expect(page.getByRole('region', { name: locale === 'da-DK' ? 'Sådan betaler du' : 'How to pay' })).toHaveCount(0)
        await caller.invoices.send({ id: draft.id, allowSendWithoutEmail: true })
        const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id }, include: { contact: true, items: true } })
        const publicPaymentUrl = withBank ? (await caller.invoices.createPaymentLink({ id: draft.id })).url : null
        await caller.paymentDetails.update({ bankAccount: { regNumber: '1234', accountNumber: '9876543' }, note: 'Changed current payment note' })
        await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { companyName: 'Changed current seller', companyAddress: 'Changed current address' } })
        const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: setup.organizationId } })

        await page.goto(`/invoices/${issued.id}`)
        const seller = page.getByRole('region', { name: locale === 'da-DK' ? 'Fra' : 'From', exact: true })
        await expect(seller).toContainText('Synthetic Seller ApS')
        await expect(seller).toContainText('Testvej 1')
        await expect(seller).toContainText('CVR-nr.: 12345678')
        await expect(page.getByText(locale === 'da-DK' ? 'Fakturer til' : 'Bill To', { exact: true })).toBeVisible()
        const payment = page.getByRole('region', { name: locale === 'da-DK' ? 'Sådan betaler du' : 'How to pay' })
        if (withBank) {
          await expect(payment).toContainText(bankKind === 'iban' ? 'DK50 0040 0440 1162 43' : '0440 116 243')
          if (bankKind === 'iban') await expect(payment).toContainText('DABADKKK')
          else {
            await expect(payment).toContainText('0040')
            await expect(payment).toContainText('Issue-time payment note')
          }
          await expect(payment).toContainText(locale === 'da-DK' ? 'Skriv fakturanummeret i beskeden, så vi kan finde din betaling.' : 'Add the invoice number to the payment message so we can match your payment.')
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
        // Every action must fit, including the last action at 390px.
        for (const button of await page.locator('button:visible').all()) {
          expect(await button.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
        }
        await page.reload()
        await expect(seller).toContainText('Synthetic Seller ApS')
        if (withBank) await expect(payment).toContainText(bankKind === 'iban' ? 'DK50 0040 0440 1162 43' : '0440 116 243')

        // Inspect the same rendered email the outbox composes, without sending to a provider.
        const email = composeInvoiceEmail({ invoice: { ...issued, number: issued.number! }, settings, to: contact.email!, publicPaymentUrl }).message
        await page.setViewportSize({ width: 390, height: 844 })
        expect(email.html).not.toMatch(/@font-face|@import|cdn\.jsdelivr\.net|\.woff2?/)
        await page.setContent(email.html!)
        await expect(page.getByRole('heading', { name: locale === 'da-DK' ? 'Sådan betaler du' : 'How to pay' })).toBeVisible()
        await expect(page.getByText(locale === 'da-DK' ? 'Skriv fakturanummeret i beskeden, så vi kan finde din betaling.' : 'Add the invoice number to the payment message so we can match your payment.', { exact: true })).toBeVisible()
        if (withBank) {
          await expect(page.getByText(bankKind === 'iban' ? 'DK50 0040 0440 1162 43' : '0440 116 243', { exact: true })).toBeVisible()
          if (bankKind === 'iban') await expect(page.getByText('DABADKKK', { exact: true })).toBeVisible()
          else await expect(page.getByText('0040', { exact: true })).toBeVisible()
          await expect(page.getByRole('link', { name: locale === 'da-DK' ? 'Betal faktura' : 'Pay invoice', exact: true }).first()).toHaveAttribute('href', publicPaymentUrl!)
        } else {
          await expect(page.getByText(/Reg\.nr\.|Reg\. no\.|Account number|Kontonummer/)).toHaveCount(0)
        }
        await expect(page.getByText('Changed current payment note')).toHaveCount(0)
        await expect(page.getByText(/Betalingsreference|Payment reference/)).toHaveCount(0)
        await expect(page.locator('.invoice-items thead')).toBeHidden()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (withBank) {
          await expect(page.getByText(publicPaymentUrl!, { exact: true })).toHaveCount(0)
          const paymentRows = page.getByRole('table', { name: locale === 'da-DK' ? 'Sådan betaler du' : 'How to pay' })
          await expect(paymentRows).toContainText(issued.number!)
          expect(await paymentRows.locator('td').first().evaluate(cell => getComputedStyle(cell).textAlign)).toBe('right')
          expect(await paymentRows.locator('th').first().evaluate(cell => getComputedStyle(cell).textTransform)).toBe('uppercase')
        }
        expect(await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe(theme === 'dark' ? 'rgb(17, 17, 18)' : 'rgb(250, 250, 249)')
        await testInfo.attach('invoice-email-mobile', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
        if (bankKind === 'domestic') {
          // Actual payment/credit commands populate the balances used by both rendering paths.
          for (const step of ['partial payment', 'partial credit', 'fully settled'] as const) {
            if (step === 'partial payment') await caller.payments.record({ invoiceId: issued.id, amount: 500, paidAt: new Date().toISOString(), method: 'bank_transfer' })
            if (step === 'partial credit') await caller.creditNotes.issue({ invoiceId: issued.id, mode: 'amount', amount: 250, reason: 'MOCK test credit' })
            if (step === 'fully settled') await caller.invoices.markPaid({ invoiceId: issued.id, requestId: crypto.randomUUID() })
            const expected = step === 'partial payment' ? 2000 : step === 'partial credit' ? 1750 : 0
            const current = await caller.invoices.get({ id: issued.id })
            expect(current.balanceDue).toBe(expected)
            expect(current.total).toBe(2500)
            await page.goto(`/invoices/${issued.id}`)
            await expect(payment.locator('dd').first()).toHaveText(new Intl.NumberFormat(locale, { style: 'currency', currency: 'DKK' }).format(expected))
            await expect(payment).toContainText('0440 116 243')
            const fresh = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id }, include: { contact: true, items: true } })
            expect(fresh.issuanceSnapshot).toEqual(issued.issuanceSnapshot)
            expect(fresh.artifactPdfHash).toBe(issued.artifactPdfHash)
            expect(fresh.artifactPdfRef).toBe(issued.artifactPdfRef)
            const updatedEmail = composeInvoiceEmail({ invoice: { ...fresh, number: fresh.number! }, settings, to: contact.email!, publicPaymentUrl: null }).message
            await page.setContent(updatedEmail.html!)
            const rows = page.getByRole('table', { name: locale === 'da-DK' ? 'Sådan betaler du' : 'How to pay' })
            await expect(rows.locator('td').first()).toHaveText(new Intl.NumberFormat(locale, { style: 'currency', currency: 'DKK' }).format(expected))
            await expect(rows).toContainText(issued.number!)
          }
        }

      })
    }
}

}
