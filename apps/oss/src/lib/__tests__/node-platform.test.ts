import { afterEach, expect, test, vi } from 'vitest'
import { defaultNodePlatform } from '../runtime/node-platform'

const originalClient = globalThis.__prisma

afterEach(async () => {
  if (globalThis.__prisma !== originalClient) await globalThis.__prisma?.$disconnect()
  globalThis.__prisma = originalClient
  vi.unstubAllEnvs()
})

test('production Node requests share a Prisma client instead of opening a pool per access', () => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:5432/quits_e2e')
  globalThis.__prisma = undefined
  const first = defaultNodePlatform.getPrisma()
  for (let request = 0; request < 100; request++) {
    expect(defaultNodePlatform.getPrisma()).toBe(first)
  }
})
