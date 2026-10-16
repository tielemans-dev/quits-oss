// MOCK/TODO: CI-only synthetic review capture, never a production entry point.
import path from 'node:path'
import { createHarness, assertNoEnvFiles } from './harness.mjs'

/** @param {{ cwd: string; baseline?: string }} options */
export async function runPaymentCapture({ cwd, baseline }) {
  assertNoEnvFiles([cwd, path.resolve(cwd, '../..')])
  if (!process.env.CI) throw new Error('QUI-52 capture runs in GitHub CI only')
  const baseURL = 'http://127.0.0.1:4310'
  const harness = await createHarness({ cwd, logDir: path.join(cwd, 'test-results/shared-logs') })
  Object.assign(harness.env, {
    QUITS_E2E_MANAGED: '1', PLAYWRIGHT_BASE_URL: baseURL,
    BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: 'MOCK-shared-browser-only-secret-over-32-characters',
    QUITS_APP_ORIGIN: baseURL, QUITS_DISTRIBUTION: 'selfhost', VITE_QUITS_DISTRIBUTION: 'selfhost',
    HOST: '127.0.0.1', PORT: '4310',
    EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025',
    SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', FROM_EMAIL: 'MOCK-review@example.invalid',
    QUI52_MAILPIT_URL: 'http://127.0.0.1:8025',
    ...(baseline ? { QUI52_CAPTURE_BASELINE: baseline } : {}),
    QUI52_CAPTURE_OUTPUT: path.join(cwd, baseline ? 'test-results/qui52-before' : 'test-results/qui52-current'),
  })
  try {
    await harness.run('bunx', ['prisma', 'generate'])
    await harness.run('bunx', ['prisma', 'migrate', 'deploy'])
    await harness.run('bunx', ['--no-install', 'vp', 'build'])
    await harness.serve('node', ['.output/server/index.mjs'], `${baseURL}/login`, { name: 'app' })
    await harness.run('bunx', ['playwright', 'test', '-c', 'playwright.shared.config.ts', 'invoice-payment-capture.spec.ts', '--workers=1'], { name: 'playwright' })
  } finally { await harness.close() }
}
