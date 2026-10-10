import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRuntimePlatform, resetRuntimePlatform } from '../runtime/platform'
import { applySetupInitialization } from '../setup/apply'
import type { SetupInitializeInput } from '../setup/validators'
import type { AuthHooks } from '../runtime/auth-config'
const { findUnique, createUser, transaction, consume, getSetupStatus } = vi.hoisted(() => ({
  findUnique: vi.fn(), createUser: vi.fn(), transaction: vi.fn(), consume: vi.fn(), getSetupStatus: vi.fn(),
}))
vi.mock('../db', () => ({ prisma: { $transaction: transaction, installationState: { findUnique: getSetupStatus },
  organization: { count: vi.fn().mockResolvedValue(0) }, user: { count: vi.fn().mockResolvedValue(0) },
  member: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) },
} }))
vi.mock('better-auth/crypto', () => ({ hashPassword: async () => 'synthetic-hash' }))
vi.mock('@tanstack/react-start/server', () => ({ getRequest: () => new Request('http://localhost/setup', { headers: { 'x-quits-invite': 'test-code' } }) }))
const input: SetupInitializeInput = { admin: { email: 'TEST@example.test', name: 'Test', password: 'local-password123' },
  locale: { currency: 'DKK', countryCode: 'DK', timezone: 'Europe/Copenhagen', locale: 'da' },
  organization: { name: 'Test', slug: 'test' }, auth: { mode: 'local_only' }, instanceProfile: 'freelancer' }
function policy(hooks: AuthHooks = {}, mode?: string) {
  setRuntimePlatform({ id: 'setup-policy-test', getRuntimeKind: () => 'node', getEnv: (key) => key === 'SIGNUP_MODE' ? mode : undefined,
    getAuthHooks: () => hooks, getBinding: () => undefined, getPrisma: () => null })
}
afterEach(() => { resetRuntimePlatform(); vi.clearAllMocks() })
describe('installation administrator admission', () => {
  it('denies before any account lookup when a restriction is configured', async () => {
    policy({}, 'invite_only')
    await expect(applySetupInitialization(input)).rejects.toMatchObject({ body: { code: 'not_invited' } })
    expect(getSetupStatus).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled()
  })
  it('passes normalized email and trusted request to the policy', async () => {
    const authorizeSignUp = vi.fn<NonNullable<AuthHooks['authorizeSignUp']>>(async () => ({ ok: false as const, code: 'invite_invalid' as const }))
    policy({ authorizeSignUp })
    await expect(applySetupInitialization(input)).rejects.toMatchObject({ body: { code: 'invite_invalid' } })
    expect(authorizeSignUp.mock.calls[0]![0]).toMatchObject({ email: 'test@example.test', inviteCode: 'TEST-CODE' })
  })
  it('consumes using the administrator insert transaction', async () => {
    policy({ authorizeSignUp: async () => ({ ok: true, consumeInvite: consume }) })
    getSetupStatus.mockResolvedValue({ id: 'default', isSetupComplete: false, distribution: 'selfhost', setupVersion: 1 })
    findUnique.mockResolvedValue(null)
    // End deliberately at the insert. The existing database integration test covers default setup.
    createUser.mockRejectedValue(new Error('synthetic-insert-failure'))
    const tx = { user: { findUnique, create: createUser }, organization: { findUnique } }
    transaction.mockImplementation(async (work) => work(tx))
    await expect(applySetupInitialization(input)).rejects.toThrow('synthetic-insert-failure')
    expect(consume).toHaveBeenCalledExactlyOnceWith(tx)
    expect(createUser).toHaveBeenCalledOnce()
  })
})
