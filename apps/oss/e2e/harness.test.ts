import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertNoEnvFiles, testEnvironment } from './harness.mjs'

afterEach(() => vi.unstubAllEnvs())

test('does not pass developer databases, provider credentials or arbitrary Node flags to children', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://private.invalid/production')
  vi.stubEnv('OSS_DATABASE_URL', 'postgresql://private.invalid/production')
  vi.stubEnv('RESEND_API_KEY', 'real-key')
  vi.stubEnv('SMTP_HOST', 'smtp.private.invalid')
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'real-token')
  vi.stubEnv('NODE_OPTIONS', '--require /private/bootstrap.cjs')
  const env = testEnvironment()
  expect(env).not.toHaveProperty('DATABASE_URL')
  expect(env).not.toHaveProperty('OSS_DATABASE_URL')
  expect(env.RESEND_API_KEY).toBe('')
  expect(env.SMTP_HOST).toBe('')
  expect(env.CLOUDFLARE_API_TOKEN).toBe('')
  expect(env.NODE_OPTIONS).not.toContain('--require')
})

test('preserves toolchain paths and CI while fixing locale and time', () => {
  vi.stubEnv('CI', 'true')
  vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '/tmp/browser-cache')
  const env = testEnvironment()
  expect(env.PATH).toBe(process.env.PATH)
  expect(env.CI).toBe('true')
  expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe('/tmp/browser-cache')
  expect(env.TZ).toBe('UTC')
})

test('rejects active env files before a build without rejecting example files', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'quits-e2e-env-'))
  try {
    writeFileSync(path.join(directory, '.env.example'), 'VITE_EXAMPLE=example')
    expect(() => assertNoEnvFiles([directory])).not.toThrow()
    writeFileSync(path.join(directory, '.env.production.local'), 'VITE_EXAMPLE=developer')
    expect(() => assertNoEnvFiles([directory])).toThrow('clean checkout')
  } finally { rmSync(directory, { recursive: true }) }
})
