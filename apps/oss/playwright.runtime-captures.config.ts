import { defineConfig } from '@playwright/test'
export default defineConfig({
 testDir: './tests/onboarding-v2', testMatch: 'runtime-captures.ts', workers: 1, timeout: 120_000, reporter: 'list',
 use: { baseURL: 'http://127.0.0.1:3086' },
 webServer: {
 command: process.env.SCREENSHOT_PHASE === 'before' ? 'bunx vite dev --host 127.0.0.1 --port 3086' : 'bunx vite dev --config tests/onboarding-v2/runtime.vite.config.ts --host 127.0.0.1 --port 3086',
 cwd: `${process.env.SCREENSHOT_CWD}/apps/oss`, url: 'http://127.0.0.1:3086/login', timeout: 120_000, reuseExistingServer: false,
 env: { ...process.env, QUITS_DISTRIBUTION: 'cloud', VITE_QUITS_DISTRIBUTION: 'cloud', BETTER_AUTH_URL: 'http://127.0.0.1:3086', QUITS_APP_ORIGIN: 'http://127.0.0.1:3086', BETTER_AUTH_SECRET: 'synthetic-qui56-screen-secret-over-32-characters', QUITS_DEVTOOLS_EVENT_BUS_PORT: '42886', NODE_OPTIONS: '--max-old-space-size=2048' },
 },
})
