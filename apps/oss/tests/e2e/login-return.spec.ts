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

for (const lang of ['da', 'en']) {
  test(`login keeps explicit ${lang} on the default destination`, async ({ page }) => {
    test.skip(process.env.QUITS_DISTRIBUTION === 'cloud', 'Dashboard default is selfhost-only')
    await page.goto(`/login?lang=${lang}`)
    await waitForClientReady(page)
    await page.getByLabel(lang === 'da' ? 'E-mail' : 'Email').fill(adminCredentials.email)
    await page.getByLabel(lang === 'da' ? 'Adgangskode' : 'Password').fill(adminCredentials.password)
    await page.getByRole('button', { name: lang === 'da' ? 'Log ind' : 'Log in', exact: true }).click()
    await expect(page).toHaveURL(new URL(`/?lang=${lang}`, page.url()).href)
    // The destination retains lang; the dashboard's copy follows the saved organization locale.
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  })
}

test('a signed-out visit to a protected page logs in and resumes it', async ({ page }) => {
  const target = '/invoices?filter=a%20b&tab=all'
  await page.goto(target)
  await expect(page).toHaveURL(/\/login\?/)
  expect(new URL(page.url()).searchParams.get('redirect')).toBe(target)
  await waitForClientReady(page)
  const signup = await page.getByRole('link', { name: 'Sign up' }).getAttribute('href')
  expect(new URL(signup!, page.url()).searchParams.get('redirect')).toBe(target)
  await page.getByLabel('Email').fill(adminCredentials.email)
  await page.getByLabel('Password').fill(adminCredentials.password)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await expect(page).toHaveURL(/\/invoices\?filter=a%20b&tab=all/)
})
