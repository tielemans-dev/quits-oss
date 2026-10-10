import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverWorkspaceEnvFile } from '../../../scripts/workspace-env.js'
import { createHarness, assertNoEnvFiles } from './harness.mjs'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const discoveredEnv = discoverWorkspaceEnvFile({ cwd })
assertNoEnvFiles([cwd, path.resolve(cwd, '../..'), ...(discoveredEnv ? [path.dirname(discoveredEnv)] : [])])
const baseURL = 'http://127.0.0.1:4310'
const harness = await createHarness({ cwd, logDir: path.join(cwd, 'test-results/shared-logs') })
Object.assign(harness.env, {
  QUITS_E2E_MANAGED: '1', PLAYWRIGHT_BASE_URL: baseURL,
  QUITS_MCP_OAUTH_PROTOTYPE: 'true',
  BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: 'shared-browser-only-secret-over-32-characters',
  QUITS_APP_ORIGIN: baseURL, QUITS_DISTRIBUTION: 'selfhost', VITE_QUITS_DISTRIBUTION: 'selfhost',
  HOST: '127.0.0.1', PORT: '4310',
})
try {
  await harness.run('bunx', ['prisma', 'generate'])
  await harness.run('bunx', ['prisma', 'migrate', 'deploy'])
  await harness.run('bunx', ['vite', 'build'])
  await harness.serve('node', ['.output/server/index.mjs'], `${baseURL}/login`, { name: 'app' })
  await harness.run('bunx', ['playwright', 'test', '-c', 'playwright.shared.config.ts', ...process.argv.slice(2)], { name: 'playwright' })
  console.log('Shared browser scenarios passed. Reports: apps/oss/playwright-report/shared')
} finally { await harness.close() }
