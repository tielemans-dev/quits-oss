import { expect, test, vi } from 'vitest'
import { registerProductScenarios } from './scenarios.mjs'

// MOCK browser protocol: hydration resets the first email entry before password entry.
// No server, account, database or provider is contacted by these tests.
function signInFixture(status = 200) {
  let beforeEach: (fixtures: unknown) => Promise<void> = async () => {}
  const register = Object.assign(() => {}, {
    beforeEach: (hook: typeof beforeEach) => { beforeEach = hook },
  })
  const values = { Email: '', Password: '' }
  let fills = 0
  const click = vi.fn(async () => {
    if (!values.Email || !values.Password) throw new Error('Native validation prevented sign-in POST')
  })
  const page = {
    goto: vi.fn(),
    getByLabel: (label: keyof typeof values) => ({
      fill: async (value: string) => {
        values[label] = value
        if (++fills === 2) values.Email = ''
      },
      value: () => values[label],
    }),
    getByRole: () => ({ click }),
    waitForResponse: async () => ({ status: () => status, ok: () => status === 200 }),
  }
  const assertions = (target: unknown, message?: string) => ({
    toHaveURL: async () => {},
    toBeVisible: async () => {},
    toBeTruthy: () => expect(target, message).toBeTruthy(),
    toHaveValue: async (value: string) => {
      expect((target as { value: () => string }).value()).toBe(value)
    },
    toPass: async (options: { timeout: number }) => {
      await vi.waitFor(target as () => Promise<void>, { timeout: options.timeout, interval: 1 })
    },
  })
  registerProductScenarios(
    register as unknown as Parameters<typeof registerProductScenarios>[0],
    assertions as unknown as Parameters<typeof registerProductScenarios>[1],
  )
  return {
    click,
    run: () => beforeEach({ page, account: { email: 'admin@example.invalid', password: 'MOCK password' }, entryURL: 'http://example.invalid/' }),
  }
}

test('shared sign-in recovers credentials reset during hydration before submitting', async () => {
  const fixture = signInFixture()
  await expect(fixture.run()).resolves.toBeUndefined()
  expect(fixture.click).toHaveBeenCalledTimes(1)
})

test('shared sign-in still fails authentication errors without retrying the submit', async () => {
  const fixture = signInFixture(401)
  await expect(fixture.run()).rejects.toThrow('Browser sign-in returned 401')
  expect(fixture.click).toHaveBeenCalledTimes(1)
})
