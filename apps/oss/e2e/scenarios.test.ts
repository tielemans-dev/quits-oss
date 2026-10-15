import { expect, test, vi } from 'vitest'
import { registerProductScenarios } from './scenarios.mjs'

// MOCK browser protocol and virtual clock: hydration resets credentials after both fills.
// Locator assertions poll until their deadline; timeout 0 leaves only the test deadline.
// The outer retry cannot interrupt an awaited locator assertion.
// No server, account, database or provider is contacted by these tests.
function signInFixture(status = 200, reset: 'Email' | 'Password' = 'Email', persistent = false, delayedHydration = false) {
  let elapsed = 0
  const testDeadline = 30_000
  let beforeEach: (fixtures: unknown) => Promise<void> = async () => {}
  const register = Object.assign(() => {}, {
    beforeEach: (hook: typeof beforeEach) => { beforeEach = hook },
  })
  const values = { Email: '', Password: '' }
  let fills = 0
  let hydrated = false
  const click = vi.fn(async () => {
    if (delayedHydration && !hydrated) values.Email = ''
    if (!values.Email || !values.Password) throw new Error('Native validation prevented sign-in POST')
  })
  const page = {
    goto: vi.fn(),
    locator: () => ({ waitFor: async () => { hydrated = true } }),
    getByLabel: (label: keyof typeof values) => ({
      fill: async (value: string) => {
        values[label] = value
        if (++fills === 2 || (persistent && fills % 2 === 0)) values[reset] = ''
      },
      inputValue: async () => values[label],
    }),
    getByRole: () => ({ click }),
    waitForResponse: async () => ({ status: () => status, ok: () => status === 200 }),
  }
  const assertions = (target: unknown, message?: string) => ({
    toHaveURL: async () => {},
    toBeVisible: async () => {},
    toBeTruthy: () => expect(target, message).toBeTruthy(),
    toBe: (value: unknown) => expect(target, message).toBe(value),
    toHaveValue: async (value: string, options: { timeout?: number } = {}) => {
      const timeout = options.timeout ?? 5_000
      const deadline = timeout === 0 ? testDeadline : Math.min(elapsed + timeout, testDeadline)
      const input = target as { inputValue: () => Promise<string> }
      while (await input.inputValue() !== value) {
        if (elapsed >= deadline) throw new Error('Locator assertion deadline reached')
        elapsed = Math.min(elapsed + 100, deadline)
      }
    },
    toPass: async (options: { timeout: number }) => {
      const deadline = elapsed + options.timeout
      for (;;) {
        try {
          await (target as () => Promise<void>)()
          return
        } catch (error) {
          if (elapsed >= deadline) throw error
          elapsed = Math.min(elapsed + 100, deadline)
        }
      }
    },
  })
  registerProductScenarios(
    register as unknown as Parameters<typeof registerProductScenarios>[0],
    assertions as unknown as Parameters<typeof registerProductScenarios>[1],
  )
  return {
    click,
    elapsed: () => elapsed,
    fills: () => fills,
    run: () => beforeEach({ page, account: { email: 'admin@example.invalid', password: 'MOCK password' }, entryURL: 'http://example.invalid/' }),
  }
}

test.each(['Email', 'Password'] as const)('shared sign-in refills both credentials after hydration resets %s', async (reset) => {
  const fixture = signInFixture(200, reset)
  await expect(fixture.run()).resolves.toBeUndefined()
  expect(fixture.click).toHaveBeenCalledTimes(1)
  expect(fixture.fills()).toBe(4)
  expect(fixture.elapsed()).toBe(100)
})

test('shared sign-in still fails authentication errors without retrying the submit', async () => {
  const fixture = signInFixture(401)
  await expect(fixture.run()).rejects.toThrow('Browser sign-in returned 401')
  expect(fixture.click).toHaveBeenCalledTimes(1)
})

test.each(['Email', 'Password'] as const)('shared sign-in stops persistent %s resets after 15 seconds without submitting', async (reset) => {
  const fixture = signInFixture(200, reset, true)
  await expect(fixture.run()).rejects.toThrow()
  expect(fixture.elapsed()).toBe(15_000)
  expect(fixture.fills()).toBeGreaterThan(2)
  expect(fixture.click).not.toHaveBeenCalled()
})

test('shared sign-in waits when hydration would reset credentials after both reads', async () => {
  const fixture = signInFixture(200, 'Email', false, true)
  await expect(fixture.run()).resolves.toBeUndefined()
  expect(fixture.click).toHaveBeenCalledTimes(1)
})
