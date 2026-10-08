// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const settings = vi.hoisted(() => ({ query: vi.fn(), organizationId: 'org1' as string | null }))
vi.mock('../../trpc/client', () => ({ trpc: { settings: { get: { query: settings.query } } } }))
vi.mock('../active-organization', () => ({ getRequestOrganizationId: () => settings.organizationId }))
import { loadOrganizationSettings } from '../organization-settings-query'
beforeEach(() => { settings.query.mockReset(); settings.organizationId = 'org1' })
afterEach(() => vi.unstubAllEnvs())

it('shares simultaneous settings reads but reads again after settlement', async () => {
  let resolve!: (value: unknown) => void
  settings.query.mockReturnValueOnce(new Promise(r => { resolve = r }))
  const a = loadOrganizationSettings()
  const b = loadOrganizationSettings()
  expect(a).toBe(b)
  expect(settings.query).toHaveBeenCalledTimes(1)
  resolve({ locale: 'en-US' })
  await a
  settings.query.mockResolvedValue({ locale: 'da-DK' })
  await expect(loadOrganizationSettings()).resolves.toMatchObject({ locale: 'da-DK' })
  expect(settings.query).toHaveBeenCalledTimes(2)
})

it('isolates organizations and never remembers a rejected query', async () => {
  settings.query.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ locale: 'en-US' })
  const a = loadOrganizationSettings()
  settings.organizationId = 'org2'
  const b = loadOrganizationSettings()
  expect(a).not.toBe(b)
  await expect(a).rejects.toThrow('offline')
  await b
  settings.organizationId = 'org1'
  await loadOrganizationSettings()
  expect(settings.query).toHaveBeenCalledTimes(3)
})

it('does not send an unscoped request before the layout initializes its organization', async () => {
  settings.organizationId = null
  await expect(loadOrganizationSettings()).rejects.toThrow('No request organization')
  expect(settings.query).not.toHaveBeenCalled()
})

it('does not share promises across server requests', async () => {
  vi.stubEnv('SSR', true)
  settings.query.mockImplementation(async () => ({ locale: 'en-US' }))
  const a = loadOrganizationSettings()
  const b = loadOrganizationSettings()
  expect(a).not.toBe(b)
  await Promise.all([a, b])
  expect(settings.query).toHaveBeenCalledTimes(2)
})
