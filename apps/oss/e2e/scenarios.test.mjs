import { expect, test } from 'vitest'
import { registerProductScenarios } from './scenarios.mjs'

test('shared login retains the email when hydration occurs after the first fill', async () => {
  const account = { email: 'admin@example.invalid', password: 'test-password' }
  let beforeEach
  const register = () => {}
  register.beforeEach = hook => { beforeEach = hook }
  let hydrated = false
  let submitted = false
  const values = { Email: '', Password: '' }
  const attributes = { Email: '', Password: '' }
  const hydrate = () => {
    if (hydrated) return
    hydrated = true
    // The first fill changed the SSR DOM but never reached React's onChange.
    values.Email = ''
  }
  const page = {
    async goto() {},
    getByLabel(label) {
      return {
        async fill(value) {
          if (label === 'Password') hydrate()
          values[label] = value
          if (hydrated) attributes[label] = value
        },
        async getAttribute() {
          hydrate()
          return attributes[label]
        },
      }
    },
    getByRole(role) {
      return {
        async click() {
          // Native required-field validation prevents submission in the captured failure.
          expect(values.Email, 'email must survive hydration before submit').toBe(account.email)
          expect(values.Password).toBe(account.password)
          submitted = true
        },
        async toBeVisible() { expect(role).not.toBe('button') },
      }
    },
    async waitForResponse() {
      return { status: () => 200, ok: () => true }
    },
  }
  const browserExpect = (target, message) => target === page
    ? { async toHaveURL() {} }
    : target.toBeVisible ? target : expect(target, message)
  browserExpect.poll = expect.poll
  registerProductScenarios(register, browserExpect)
  await beforeEach({ page, account, entryURL: 'https://example.invalid/' })
  expect(submitted).toBe(true)
})
