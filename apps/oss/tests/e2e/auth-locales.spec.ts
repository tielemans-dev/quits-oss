import { expect, test } from '@playwright/test'
import { PASSWORD_MIN_LENGTH } from '../../src/lib/auth/password-policy'
import { resetDatabase, seedCompletedSetup, waitForClientReady } from './support'

for (const lang of ['da', 'en'] as const) {
  for (const width of [1440, 390]) {
    test(`auth language and recovery links ${lang} at ${width}px`, async ({ page }) => {
      await resetDatabase()
      await seedCompletedSetup()
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      const redirect = '/invoices?tab=paid'
      await page.goto('/login?lang=' + lang + '&redirect=' + encodeURIComponent(redirect))
      await waitForClientReady(page)
      await expect(page.getByRole('img', { name: 'quits' })).toBeVisible()
      await expect(page.getByRole('button', { name: lang === 'da' ? 'Log ind' : 'Log in', exact: true })).toBeVisible()
      await page.getByRole('link', { name: lang === 'da' ? 'Glemt adgangskode?' : 'Forgot password?' }).click()
      await expect(page).toHaveURL((url) => url.pathname === '/forgot-password' && url.searchParams.get('lang') === lang)
      await expect(page.getByRole('img', { name: 'quits' })).toBeVisible()
      await expect(page.getByRole('button', { name: lang === 'da' ? 'Send link' : 'Send reset link' })).toBeVisible()
      const back = page.getByRole('link', { name: lang === 'da' ? 'Tilbage til log ind' : 'Back to log in' })
      await expect(back).toHaveAttribute('href', '/login?lang=' + lang + '&redirect=' + encodeURIComponent(redirect))
      await back.click()
      await page.getByRole('link', { name: lang === 'da' ? 'Opret konto' : 'Sign up', exact: true }).click()
      await expect(page.getByRole('button', { name: lang === 'da' ? 'Opret konto' : 'Create account', exact: true })).toBeVisible()
      await expect(page.getByLabel(lang === 'da' ? 'Adgangskode' : 'Password', { exact: true })).toHaveAttribute('minlength', String(PASSWORD_MIN_LENGTH))
      await expect(page.getByLabel(lang === 'da' ? 'Adgangskode' : 'Password', { exact: true })).toHaveAttribute('maxlength', '128')
      await page.goto('/reset-password?token=synthetic-unused-token&lang=' + lang + '&redirect=' + encodeURIComponent(redirect))
      await waitForClientReady(page)
      await expect(page.getByLabel(lang === 'da' ? 'Gentag adgangskode' : 'Repeat password')).toBeVisible()
      await page.getByRole('link', { name: lang === 'da' ? 'English' : 'Dansk', exact: true }).click()
      const toggled = new URL(page.url())
      expect(toggled.searchParams.get('token')).toBe('synthetic-unused-token')
      expect(toggled.searchParams.get('redirect')).toBe(redirect)
      expect(toggled.searchParams.get('lang')).toBe(lang === 'da' ? 'en' : 'da')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
  }
}
