import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/lib/db'
import { signReminderUnsubscribeToken } from '../../src/lib/reminders/unsubscribe-token'
import { resetDatabase, seedCompletedSetup, danishLocale, loginAsAdmin } from '../e2e/support'

for (const width of [390, 1440]) {
  test(`Danish reminder preferences at ${width}px without login`, async ({ page, baseURL }, info) => {
    const database = new URL(process.env.DATABASE_URL!)
    if (!baseURL?.startsWith('http://127.0.0.1:') || database.hostname !== '127.0.0.1' || database.pathname !== '/quits_e2e') throw new Error('Requires the shared disposable environment')
    const capture = async (name: string) => {
      const path = info.outputPath(`reminder-preferences-${name}-da-${width}.png`)
      await page.screenshot({ path, fullPage: true })
      await info.attach(`${name}-da-${width}`, { path, contentType: 'image/png' })
    }
    const id = randomUUID()
    await prisma.organization.create({ data: { id, name: 'Eksempel ApS', slug: id, createdAt: new Date() } })
    try {
      const preference = await prisma.recipientReminderPreference.create({ data: { organizationId: id, recipient: 'buyer@example.invalid', locale: 'da-DK' } })
      const token = signReminderUnsubscribeToken(preference, process.env.BETTER_AUTH_SECRET!)
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/reminders/unsubscribe?token=${token}`)
      await expect(page.getByRole('heading', { name: 'Automatiske påmindelser er slået til' })).toBeVisible()
      expect((await prisma.recipientReminderPreference.findUniqueOrThrow({ where: { id: preference.id } })).unsubscribedAt).toBeNull()
      await capture('unsubscribe-confirm')
      await page.getByRole('button', { name: 'Stop automatiske påmindelser', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Automatiske påmindelser stoppet' })).toBeVisible()
      expect((await prisma.recipientReminderPreference.findUniqueOrThrow({ where: { id: preference.id } })).unsubscribedAt).not.toBeNull()
      await capture('unsubscribe-done')
      await page.getByRole('button', { name: 'Genoptag automatiske påmindelser', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Automatiske påmindelser er slået til' })).toBeVisible()
      expect((await prisma.recipientReminderPreference.findUniqueOrThrow({ where: { id: preference.id } })).unsubscribedAt).toBeNull()
      await capture('resubscribed')
      await page.reload()
      await expect(page.getByRole('button', { name: 'Stop automatiske påmindelser', exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    } finally {
      await prisma.organization.delete({ where: { id } })
    }
  })
}


test('seller sees and clears a customer opt-out in the app', async ({ page, baseURL }, info) => {
  const database = new URL(process.env.DATABASE_URL!)
  if (!baseURL?.startsWith('http://127.0.0.1:') || database.hostname !== '127.0.0.1' || database.pathname !== '/quits_e2e') throw new Error('Requires the shared disposable environment')
  await resetDatabase()
  const setup = await seedCompletedSetup(danishLocale)
  const contact = await prisma.contact.create({ data: { organizationId: setup.organizationId, name: 'Eksempelkunde', email: 'buyer@example.invalid' } })
  await prisma.recipientReminderPreference.create({ data: { organizationId: setup.organizationId, recipient: contact.email!, locale: 'da-DK', unsubscribedAt: new Date() } })
  await loginAsAdmin(page)
  await page.goto(`/contacts/${contact.id}`)
  await expect(page.getByRole('status')).toHaveText('Automatiske påmindelser er afmeldt')
  await info.attach('customer-opted-out-da', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  await page.getByRole('button', { name: 'Genoptag automatiske påmindelser', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Automatiske påmindelser er tilladt')
  await expect(page.getByRole('button', { name: 'Genoptag automatiske påmindelser', exact: true })).toHaveCount(0)
  await info.attach('customer-resumed-da', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  await page.reload()
  await expect(page.getByRole('status')).toHaveText('Automatiske påmindelser er tilladt')
})
