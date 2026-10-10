import { createHash, randomBytes } from 'node:crypto'
import { test, expect, type Page, type APIRequestContext, type TestInfo } from '@playwright/test'
import { prisma } from '../../src/lib/db'
import { adminCredentials, resetDatabase, seedCompletedSetup } from '../e2e/support'

// Real HTTP handlers, session cookies and browser navigation, in the shared disposable runner.
test.beforeEach(async ({ baseURL }) => {
  const database = new URL(process.env.DATABASE_URL!)
  if (!baseURL || database.hostname !== '127.0.0.1' || database.pathname !== '/quits_e2e') {
    throw new Error('MCP browser tests require the disposable shared environment')
  }
  await resetDatabase()
  await seedCompletedSetup()
})

async function authorization(request: APIRequestContext, baseURL: string) {
  const redirect = `${baseURL}/__oauth-test/callback`
  const registration = await request.post(`${baseURL}/api/mcp/oauth/register`, { data: {
    client_name: 'Browser test client', redirect_uris: [redirect],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
  } })
  expect(registration.status()).toBe(201)
  const { client_id: clientId } = await registration.json()
  const verifier = randomBytes(32).toString('base64url')
  const url = new URL(`${baseURL}/api/mcp/oauth/authorize`)
  url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    state: 'browser-state', resource: `${baseURL}/api/mcp`, scope: 'invoice:read',
  }).toString()
  return { url: url.href, clientId, verifier, redirect }
}

async function openConsent(page: Page, url: string) {
  await page.route('**/__oauth-test/callback?**', route => route.fulfill({ contentType: 'text/plain', body: 'Local client callback received' }))
  await page.goto(url)
  await expect(page).toHaveURL(/\/login\?redirect=/)
  // The first cold login navigation renders HTML before its controlled inputs hydrate.
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email', { exact: true }).fill(adminCredentials.email)
  await page.getByLabel('Password', { exact: true }).fill(adminCredentials.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/oauth\/consent\?request=/)
  await expect(page.getByText('Browser test client is asking to work in E2E Org on your behalf.', { exact: true })).toBeVisible()
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await info.attach(name, { path, contentType: 'image/png' })
}

async function mcp(request: APIRequestContext, baseURL: string, token: string) {
  return request.post(`${baseURL}/api/mcp`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'browser-test', version: '1' } } },
  })
}

test('login returns to consent, callback works, and Settings revokes the installation', async ({ page, request, baseURL }, info) => {
  const connection = await authorization(request, baseURL!)
  await openConsent(page, connection.url)
  await expect(page.getByRole('radio', { name: /^Read only/ })).toBeChecked()
  await page.getByRole('radio', { name: /^Full access/ }).check()
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled()
  await page.getByRole('checkbox').check()
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  await page.getByRole('radio', { name: /^Draft only/ }).check()
  await screenshot(page, info, 'consent-draft-only')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page).toHaveURL(/\/__oauth-test\/callback\?/)
  const callback = new URL(page.url())
  expect(callback.searchParams.get('state')).toBe('browser-state')
  expect(callback.searchParams.get('iss')).toBe(baseURL)
  const exchange = await request.post(`${baseURL}/api/mcp/oauth/token`, { form: {
    grant_type: 'authorization_code', client_id: connection.clientId, code: callback.searchParams.get('code')!,
    redirect_uri: connection.redirect, code_verifier: connection.verifier, resource: `${baseURL}/api/mcp`,
  } })
  expect(exchange.status()).toBe(200)
  const tokens = await exchange.json()
  expect(tokens.scope.split(' ')).not.toContain('invoice:send')
  expect((await mcp(request, baseURL!, tokens.access_token)).status()).toBe(200)

  await page.goto('/settings')
  const row = page.getByRole('row').filter({ hasText: 'Browser test client' })
  await expect(row.getByText('Connected app', { exact: true })).toBeVisible()
  await expect(row.getByText('Never', { exact: true })).toHaveCount(0)
  expect((await prisma.agentKey.findFirstOrThrow({ where: { name: 'Browser test client' } })).lastUsedAt).not.toBeNull()
  await expect(row.locator('[title*="invoice:read"]')).toBeVisible()
  await row.scrollIntoViewIfNeeded()
  await screenshot(page, info, 'settings-connected-app')
  await row.getByRole('button', { name: 'Revoke', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key', exact: true }).click()
  await expect(row.getByText('Revoked', { exact: true })).toBeVisible()
  await screenshot(page, info, 'settings-revoked')
  expect((await mcp(request, baseURL!, tokens.access_token)).status()).toBe(401)
  expect((await request.post(`${baseURL}/api/mcp/oauth/token`, { form: {
    grant_type: 'refresh_token', client_id: connection.clientId, refresh_token: tokens.refresh_token,
  } })).status()).toBe(400)
})

test('rejecting consent returns access_denied without creating an installation', async ({ page, request, baseURL }) => {
  const connection = await authorization(request, baseURL!)
  await openConsent(page, connection.url)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(/\/__oauth-test\/callback\?/)
  const callback = new URL(page.url())
  expect(callback.searchParams.get('error')).toBe('access_denied')
  expect(callback.searchParams.get('state')).toBe('browser-state')
  expect(callback.searchParams.get('iss')).toBe(baseURL)
  expect(await prisma.agentKey.count()).toBe(0)
})

test('changing organization in another tab refuses the displayed consent', async ({ page, request, baseURL }, info) => {
  const connection = await authorization(request, baseURL!)
  await openConsent(page, connection.url)
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: adminCredentials.email } })
  const orgB = await prisma.organization.create({ data: { id: 'oauth-org-b', name: 'Other organization', slug: 'oauth-org-b', createdAt: new Date(),
    members: { create: { id: 'oauth-org-b-admin', userId: owner.id, role: 'admin', createdAt: new Date() } },
  } })
  const second = await page.context().newPage()
  await second.goto('/settings')
  // The second tab uses the same authenticated browser session and real organization endpoint.
  const status = await second.evaluate(async (organizationId) => {
    const response = await fetch('/api/auth/organization/set-active', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId }) })
    return response.status
  }, orgB.id)
  expect(status).toBe(200)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Start again from your AI app')
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
  expect(await prisma.agentKey.count()).toBe(0)
  await screenshot(page, info, 'consent-organization-changed')
  await second.close()
})
