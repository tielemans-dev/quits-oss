import { defineConfig } from '@playwright/test'

const database = new URL(process.env.DATABASE_URL ?? 'http://missing')
if (database.hostname !== '127.0.0.1' || database.pathname !== '/quits_quality') {
  throw new Error('Quality checks require a disposable loopback database named quits_quality')
}
const baseURL = 'http://127.0.0.1:3066'
if (process.env.QUITS_WORKTREE_ENV !== '1') throw new Error('Set QUITS_WORKTREE_ENV=1 to disable inherited workspace env files')
Object.assign(process.env, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: '', RESEND_BASE_URL: 'http://127.0.0.1:9' })
export default defineConfig({
  testDir: './tests/quality', fullyParallel: false, workers: 1, forbidOnly: !!process.env.CI,
  retries: 0, timeout: 120_000, expect: { timeout: 15_000 }, updateSnapshots: 'none',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/quality', open: 'never' }]],
  outputDir: 'test-results/quality',
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFilePath}/{testName}/{arg}-{platform}{ext}',
  use: { baseURL, browserName: 'chromium', locale: 'en-US', timezoneId: 'UTC', trace: 'off' },
  webServer: process.env.QUITS_QUALITY_EXTERNAL_SERVER === '1' ? undefined : {
    command: 'bunx prisma migrate deploy && bunx vite dev --port 3066 --host 127.0.0.1',
    url: `${baseURL}/login`, reuseExistingServer: false, timeout: 120_000,
    env: { ...process.env, BETTER_AUTH_URL: baseURL, QUITS_APP_ORIGIN: baseURL,
      QUITS_DISTRIBUTION: 'selfhost', VITE_QUITS_DISTRIBUTION: 'selfhost', QUITS_DEVTOOLS_EVENT_BUS: 'off' },
  },
})
