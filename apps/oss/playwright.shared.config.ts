import { defineConfig } from '@playwright/test'

if (!process.env.QUITS_E2E_MANAGED) throw new Error('Run bun run test:e2e:shared to provision the disposable environment')
export default defineConfig({
  testDir: './tests/shared', workers: 1, fullyParallel: false,
  forbidOnly: !!process.env.CI, timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/shared', open: 'never' }]],
  outputDir: 'test-results/shared',
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL, browserName: 'chromium',
    locale: 'en-US', timezoneId: 'UTC', actionTimeout: 15_000, navigationTimeout: 30_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
})
