import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRuntimePlatform, setRuntimePlatform } from '../runtime/platform'
vi.mock('@tanstack/react-start', () => ({ createServerFn: () => ({ handler: (fn: () => unknown) => fn }) }))
import { getSignupConfiguration } from '../runtime/signup-config'
afterEach(resetRuntimePlatform)
describe('server signup configuration', () => {
  it('defaults to open without exposing operational configuration', async () => {
    setRuntimePlatform({ id: 'test', getRuntimeKind: () => 'node', getEnv: () => undefined, getAuthHooks: () => ({}), getBinding: () => undefined, getPrisma: () => null })
    expect(await getSignupConfiguration()).toEqual({ signupMode: 'open', waitlist: undefined })
  })
  it.each(['/privacy', '//external.test/privacy', '/\\external.test/privacy', 'https://external.test/privacy'])('restricts privacy navigation to same-origin paths: %s', async (path) => {
    setRuntimePlatform({ id: 'test', getRuntimeKind: () => 'node', getEnv: (key) => key === 'SIGNUP_MODE' ? 'invite_only' : undefined,
      getAuthHooks: () => ({ signupWaitlist: { privacyVersion: '2026-10-09', privacyPath: path } }), getBinding: () => undefined, getPrisma: () => null })
    expect(await getSignupConfiguration()).toEqual({ signupMode: 'invite_only', waitlist: { privacyVersion: '2026-10-09', privacyPath: '/privacy' } })
  })
})
