import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  assertNoEnvFiles: vi.fn(),
  createHarness: vi.fn(),
}))
vi.mock('./harness.mjs', () => mocks)
import { runPaymentCapture } from './qui52-runner.mjs'

const cwd = '/synthetic/apps/oss'
const baseline = '4931661dd7e53d83555590e06a2e2cf97448743b'
let harness: { env: Record<string, string>; run: ReturnType<typeof vi.fn>; serve: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.stubEnv('CI', 'true')
  harness = { env: {}, run: vi.fn().mockResolvedValue(undefined), serve: vi.fn().mockResolvedValue(undefined), close: vi.fn() }
  mocks.createHarness.mockResolvedValue(harness)
})
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks() })

it.each([undefined, baseline])('preserves capture mode %s and one-worker issued/email coverage', async baseline => {
  await runPaymentCapture({ cwd, baseline })
  expect(mocks.assertNoEnvFiles).toHaveBeenCalledWith([cwd, '/synthetic'])
  expect(harness.env).toMatchObject({
    QUITS_DISTRIBUTION: 'selfhost', EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1',
    QUI52_CAPTURE_OUTPUT: `${cwd}/test-results/qui52-${baseline ? 'before' : 'current'}`,
  })
  expect(harness.env.QUI52_CAPTURE_BASELINE).toBe(baseline)
  expect(harness.env).not.toHaveProperty('QUI52_CAPTURE_DRAFT_ONLY')
  expect(harness.run.mock.calls).toEqual([
    ['bunx', ['prisma', 'generate']],
    ['bunx', ['prisma', 'migrate', 'deploy']],
    ['bunx', ['vite', 'build']],
    ['bunx', ['playwright', 'test', '-c', 'playwright.shared.config.ts', 'invoice-payment-capture.spec.ts', '--workers=1'], { name: 'playwright' }],
  ])
  expect(harness.serve).toHaveBeenCalledWith('node', ['.output/server/index.mjs'], 'http://127.0.0.1:4310/login', { name: 'app' })
  expect(harness.run.mock.invocationCallOrder[2]).toBeLessThan(harness.serve.mock.invocationCallOrder[0]!)
  expect(harness.serve.mock.invocationCallOrder[0]).toBeLessThan(harness.run.mock.invocationCallOrder[3]!)
  expect(harness.close).toHaveBeenCalledOnce()
})

it.each(['migration', 'build', 'serve', 'capture'])('closes the disposable harness after %s failure', async step => {
  const failure = new Error(step)
  harness.run.mockImplementation((_command, args) => {
    if ((step === 'migration' && args.includes('migrate')) || (step === 'build' && args.includes('build')) || (step === 'capture' && args.includes('playwright'))) throw failure
  })
  if (step === 'serve') harness.serve.mockRejectedValue(failure)
  await expect(runPaymentCapture({ cwd })).rejects.toThrow(step)
  expect(harness.close).toHaveBeenCalledOnce()
})

it('rejects non-CI invocation before allocating a disposable database', async () => {
  vi.stubEnv('CI', '')
  await expect(runPaymentCapture({ cwd })).rejects.toThrow('GitHub CI only')
  expect(mocks.createHarness).not.toHaveBeenCalled()
})

it('rejects active environment files before allocating a disposable database', async () => {
  mocks.assertNoEnvFiles.mockImplementation(() => { throw new Error('clean checkout required') })
  await expect(runPaymentCapture({ cwd })).rejects.toThrow('clean checkout required')
  expect(mocks.createHarness).not.toHaveBeenCalled()
})
