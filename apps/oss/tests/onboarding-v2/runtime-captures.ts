import { test, expect } from '@playwright/test'
import { resetDatabase, seedCompletedSetup, danishLocale, adminCredentials } from '../e2e/support'
import { prisma } from '../../src/lib/db'

test('actual app onboarding and manual-entry evidence', async ({ browser, baseURL }) => {
 const db = new URL(process.env.DATABASE_URL!)
 if (!['localhost','127.0.0.1'].includes(db.hostname) || db.pathname !== '/qui56_screens_20261012') throw Error('Disposable fixture database required')
 await resetDatabase()
 const setup = await seedCompletedSetup(danishLocale)
 await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { onboardingStatus: 'in_progress', onboardingCompletedAt: null, onboardingVersion: 1 } })
 for (const language of ['da','en']) {
  await prisma.orgSettings.update({ where: { organizationId: setup.organizationId }, data: { locale: language === 'da' ? 'da-DK' : 'en-US' } })
  for (const [device,width] of [['desktop',1440],['mobile',390]] as const) {
   const context = await browser.newContext({ viewport: { width, height: device === 'desktop' ? 1000 : 844 }, locale: language === 'da' ? 'da-DK' : 'en-GB', colorScheme: 'light' })
   const login = await context.request.post(`${baseURL}/api/auth/sign-in/email`, { headers: { origin: baseURL! }, data: { email: adminCredentials.email, password: adminCredentials.password } })
   expect(login.ok()).toBeTruthy()
   expect((await context.request.post(`${baseURL}/api/auth/organization/set-active`, { headers: { origin: baseURL! }, data: { organizationId: setup.organizationId } })).ok()).toBeTruthy()
   const page = await context.newPage()
   page.on('pageerror', error => console.log('Browser error:',error.message))
   page.on('console', message => { if (message.type() === 'error') console.log('Browser console:', message.text()) })
   page.on('response', response => { if (response.status() >= 400) console.log('HTTP failure:', response.status(), response.url()) })
   page.on('requestfailed', request => console.log('Request failed:', request.url(), request.failure()?.errorText))
   await page.goto('/onboarding')
   const capture = async (state: string) => page.screenshot({ path: `${process.env.SCREENSHOT_OUTPUT}/${process.env.SCREENSHOT_PHASE}-${state}-${language}-${device}.png`, fullPage: true })
   if (process.env.SCREENSHOT_PHASE === 'before') {
    await expect(page.locator('#companyName')).toBeVisible({ timeout: 30_000 }).catch(async error => {
     console.log('Hydration diagnostics:', await page.evaluate(() => ({ url: location.href, readyState: document.readyState, scripts: [...document.scripts].map(script => script.src).filter(Boolean), busy: document.querySelector('[aria-busy]')?.outerHTML, assets: performance.getEntriesByType('resource').filter(entry => /virtual|client-entry/.test(entry.name)).map(entry => entry.toJSON()) })))
     throw error
    })
    await expect(page.getByText('Loading onboarding state…', { exact: true })).not.toBeVisible({ timeout: 30_000 })
    await expect(page.locator('#countryCode')).toHaveValue('DK')
    await capture('manual')
    await page.locator('#companyName').fill('Synthetic Manual Studio')
    await page.locator('#companyAddress').fill('Testvej 2, 1000 København')
    await expect(page.locator('#companyName')).toHaveValue('Synthetic Manual Studio')
    await expect(page.locator('#companyAddress')).toHaveValue('Testvej 2, 1000 København')
    await capture('manual-entered')
   } else {
    const search = page.getByRole('textbox', { name: language === 'da' ? 'Hvad hedder din virksomhed?' : "What's your company called?" })
    await expect(search).toBeVisible({ timeout: 30_000 }).catch(async error => {
     console.log('After hydration diagnostics:', await page.evaluate(() => ({ url: location.href, readyState: document.readyState, body: document.body.innerText.slice(0, 1000), scripts: [...document.scripts].map(script => script.src).filter(Boolean), busy: document.querySelector('[aria-busy]')?.outerHTML, assets: performance.getEntriesByType('resource').filter(entry => /virtual|client-entry/.test(entry.name)).map(entry => entry.toJSON()) })))
     throw error
    })
    await capture('01-company')
    await search.fill('Synthetic')
    const match = page.getByRole('button', { name: /Synthetic Studio ApS/ })
    await expect(match).toBeVisible()
    await capture('01-results')
    await match.click()
    await expect(page.locator('.ob-working')).toBeVisible()
    await capture('02-lookup')
    await expect(page.getByRole('heading', { name: language === 'da' ? 'Tjek dine indstillinger' : 'Check your settings' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('combobox', { name: language === 'da' ? 'Land' : 'Country', exact: true })).toHaveValue('DK')
    await capture('03-review')
    await page.getByRole('button', { name: language === 'da' ? 'Annuller' : 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: language === 'da' ? 'Opsæt manuelt i stedet' : 'Set up manually instead', exact: true }).click()
    await expect(page.getByRole('heading', { name: language === 'da' ? 'Opsæt virksomheden selv' : 'Set up your company yourself' })).toBeVisible()
    await capture('manual')
    await page.getByRole('textbox', { name: language === 'da' ? 'Navn' : 'Name', exact: true }).fill('Synthetic Manual Studio')
    await page.getByRole('textbox', { name: language === 'da' ? 'Adresse' : 'Address', exact: true }).fill('Testvej 2, 1000 København')
    await expect(page.getByRole('textbox', { name: language === 'da' ? 'Navn' : 'Name', exact: true })).toHaveValue('Synthetic Manual Studio')
    await expect(page.getByRole('textbox', { name: language === 'da' ? 'Adresse' : 'Address', exact: true })).toHaveValue('Testvej 2, 1000 København')
    await capture('manual-entered')
   }
   await context.close()
  }
 }
})
