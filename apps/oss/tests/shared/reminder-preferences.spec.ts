import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../src/lib/db'
import { signReminderUnsubscribeToken } from '../../src/lib/reminders/unsubscribe-token'

for (const width of [390, 1440]) {
  test(`Danish reminder preferences at ${width}px without login`, async ({ page, baseURL }, info) => {
    const database = new URL(process.env.DATABASE_URL!)
    if (!baseURL?.startsWith('http://127.0.0.1:') || database.hostname !== '127.0.0.1' || database.pathname !== '/quits_e2e') throw new Error('Requires the shared disposable environment')
    const id = randomUUID()
    await prisma.organization.create({ data: { id, name: 'Eksempel ApS', slug: id, createdAt: new Date() } })
    try {
      const preference = await prisma.recipientReminderPreference.create({ data: { organizationId: id, recipient: 'buyer@example.invalid', locale: 'da-DK' } })
      const token = signReminderUnsubscribeToken(preference, process.env.BETTER_AUTH_SECRET!)
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/reminders/unsubscribe?token=${token}`)
      await expect(page.getByRole('heading', { name: 'Stop automatiske påmindelser?' })).toBeVisible()
      expect((await prisma.recipientReminderPreference.findUniqueOrThrow({ where: { id: preference.id } })).unsubscribedAt).toBeNull()
      await info.attach(`unsubscribe-confirm-da-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
      await page.getByRole('button', { name: 'Stop automatiske påmindelser', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Automatiske påmindelser stoppet' })).toBeVisible()
      expect((await prisma.recipientReminderPreference.findUniqueOrThrow({ where: { id: preference.id } })).unsubscribedAt).not.toBeNull()
      await info.attach(`unsubscribe-done-da-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    } finally {
      await prisma.organization.delete({ where: { id } })
    }
  })
}
