import { test as base, expect } from '@playwright/test'
import { registerProductScenarios, type ProductFixtures } from '../../e2e/scenarios.mjs'
import { adminCredentials, resetDatabase, seedCompletedSetup } from '../e2e/support'

// A fresh installation per test also tolerates Playwright worker restarts.
// The config uses one worker because this fixture resets the disposable database.
const test = base.extend<ProductFixtures>({
  entryURL: async ({ baseURL }, use) => { await use(`${baseURL}/`) },
  account: async ({ baseURL }, use) => {
    const database = new URL(process.env.DATABASE_URL!)
    if (!baseURL || database.hostname !== '127.0.0.1' || database.pathname !== '/quits_e2e') {
      throw new Error('Shared scenarios require the disposable browser environment')
    }
    await resetDatabase()
    await seedCompletedSetup()
    await use(adminCredentials)
  },
})
registerProductScenarios(test, expect)
