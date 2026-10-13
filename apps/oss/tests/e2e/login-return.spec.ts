import { expect, test } from '@playwright/test'
import { adminCredentials, resetDatabase, seedCompletedSetup, waitForClientReady } from './support'

// Full-app verification uses CI's disposable database; no hosted-only routes are added to OSS.
test.beforeEach(async () => {
  await resetDatabase()
  await seedCompletedSetup()
})

for (const alias of ['next', 'redirect']) {
  for (const lang of ['da', 'en']) {
    test(`login resumes ${alias} with ${lang} and the exact destination query`, async ({ page }) => {
      const target = '/invoices?filter=a%20b&tab=all'
      await page.goto(`/login?${alias}=${encodeURIComponent(target)}&lang=${lang}`)
      await waitForClientReady(page)
      await expect(page.locator('[data-slot="card-title"]')).toHaveText(lang === 'da' ? 'Log ind' : 'Log in')
      await page.getByLabel(lang === 'da' ? 'E-mail' : 'Email').fill(adminCredentials.email)
      await page.getByLabel(lang === 'da' ? 'Adgangskode' : 'Password').fill(adminCredentials.password)
      await page.getByRole('button', { name: lang === 'da' ? 'Log ind' : 'Log in', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/invoices\\?filter=a%20b&tab=all&lang=${lang}$`))
    })
  }
}
