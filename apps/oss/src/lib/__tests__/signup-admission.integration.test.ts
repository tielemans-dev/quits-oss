import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { betterAuth, type BetterAuthOptions, type DBAdapter } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../../generated/prisma/client'
import { buildQuitsAuthOptions, assertSignupDecision, type AuthHooks } from '../runtime/auth-config'
import { signupMode } from '../runtime/signup-admission'

const url = process.env.DATABASE_URL
const local = url && ['localhost', '127.0.0.1'].includes(new URL(url).hostname)
const origin = 'http://localhost:3196'
const secret = 'signup-admission-integration-secret-at-least-32-characters'
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url ?? '' }) })
const emails: string[] = []
const email = () => { const value = `admission-${randomUUID()}@example.test`; emails.push(value); return value }
beforeAll(async () => {
  if (local) await prisma.$executeRawUnsafe("CREATE TABLE signup_admission_test_grants (id TEXT PRIMARY KEY, email TEXT NOT NULL, consumed BOOLEAN NOT NULL DEFAULT FALSE, revoked BOOLEAN NOT NULL DEFAULT FALSE, expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 day'))")
})
afterAll(async () => {
  if (local) {
    await prisma.user.deleteMany({ where: { email: { in: emails } } })
    await prisma.$executeRawUnsafe('DROP TABLE signup_admission_test_grants')
  }
  await prisma.$disconnect()
})
function fixture(hooks: AuthHooks = {}, mode?: string, databaseHooks?: BetterAuthOptions['databaseHooks']) {
  const options = buildQuitsAuthOptions({ prisma, hooks, env: { getEnv: (key) => ({ BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret, SIGNUP_MODE: mode })[key] } })
  const auth = betterAuth({ ...options, secret, databaseHooks, logger: { disabled: true } })
  const post = (target: string, inviteCode?: string, headers: Record<string, string> = {}) => auth.handler(new Request(`${origin}/api/auth/sign-up/email`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ name: 'Admission Test', email: target, password: 'local-password123', ...(inviteCode ? { inviteCode } : {}) }),
  }))
  return { auth, options, post }
}
async function grant(target: string) {
  const id = randomUUID()
  await prisma.$executeRaw`INSERT INTO signup_admission_test_grants (id, email) VALUES (${id}, ${target})`
  return id
}
const admission: NonNullable<AuthHooks['authorizeSignUp']> = async ({ email: target, inviteCode }) => {
  if (!inviteCode) return { ok: false, code: 'not_invited' }
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM signup_admission_test_grants WHERE UPPER(id) = ${inviteCode} AND email = ${target} AND NOT consumed AND NOT revoked AND expires_at > clock_timestamp()`
  if (!rows.length) return { ok: false, code: 'invite_invalid' }
  return { ok: true, consumeInvite: async (tx) => {
    const claimed = await tx.$executeRaw`UPDATE signup_admission_test_grants SET consumed = TRUE WHERE id = ${rows[0]!.id} AND email = ${target} AND NOT consumed AND NOT revoked AND expires_at > clock_timestamp()`
    if (claimed !== 1) assertSignupDecision({ ok: false, code: 'invite_invalid' })
  } }
}
const consumed = async (id: string) => (await prisma.$queryRaw<{ consumed: boolean }[]>`SELECT consumed FROM signup_admission_test_grants WHERE id = ${id}`)[0]!.consumed

describe('signup presentation mode', () => {
  it('defaults open and fails closed for malformed configured modes', () => {
    expect(signupMode()).toBe('open'); expect(signupMode(' open ')).toBe('open')
    expect(signupMode('invite_only')).toBe('invite_only'); expect(signupMode('typo')).toBe('invite_only')
  })
})
describe.skipIf(!local)('transactional signup admission', () => {
  it('preserves self-host signup without hooks', async () => {
    expect((await fixture().post(email())).status).toBe(200)
  })
  it('fails closed without an invite-only policy', async () => {
    const target = email()
    expect((await fixture({}, 'invite_only').post(target)).status).toBe(403)
    expect(await prisma.user.count({ where: { email: target } })).toBe(0)
  })
  it('denies before email lookup for existing and unknown accounts', async () => {
    const target = email(); await fixture().post(target)
    const lookup = vi.fn()
    const f = fixture({ authorizeSignUp: async () => ({ ok: false, code: 'not_invited' }),
      createDatabaseAdapter: (client) => (options: Parameters<ReturnType<typeof prismaAdapter>>[0]) => {
        const adapter = prismaAdapter(client, { provider: 'postgresql' })(options)
        return { ...adapter, findOne: async (data: Parameters<typeof adapter.findOne>[0]) => { if (data.model === 'user') lookup(); return adapter.findOne(data) } }
      } })
    for (const address of [target, email()]) {
      const response = await f.post(address)
      expect(response.status).toBe(403); expect((await response.json()).code).toBe('not_invited')
    }
    expect(lookup).not.toHaveBeenCalled()
  })
  it('allows allowlisted addresses even with bad codes', async () => {
    const authorizeSignUp = vi.fn(async () => ({ ok: true as const }))
    expect((await fixture({ authorizeSignUp }).post(email(), 'WRONG')).status).toBe(200)
    expect(authorizeSignUp.mock.calls).toHaveLength(2)
  })
  it('transports body code through the actual client/handler and normalizes email', async () => {
    const target = email(); const code = await grant(target); const f = fixture({ authorizeSignUp: admission })
    const client = createAuthClient({ baseURL: origin, fetchOptions: { customFetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => f.auth.handler(new Request(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin } }))) as typeof fetch } })
    const result = await client.signUp.email({ email: target.toUpperCase(), name: 'Test', password: 'local-password123' }, { body: { inviteCode: code } })
    expect(result.error).toBeNull(); expect(result.data?.user.email).toBe(target); expect(await consumed(code)).toBe(true)
  })
  it('supports header fallback and denies used codes', async () => {
    const target = email(); const code = await grant(target); const f = fixture({ authorizeSignUp: admission })
    expect((await f.post(target, undefined, { 'x-quits-invite': code })).status).toBe(200)
    const response = await f.post(target, code)
    expect(response.status).toBe(403); expect((await response.json()).code).toBe('invite_invalid')
  })
  it('returns one code for mismatched and unknown authorizations', async () => {
    const target = email(); const code = await grant(target); const f = fixture({ authorizeSignUp: admission })
    for (const [address, value] of [[email(), code], [target, 'UNKNOWN']]) {
      const response = await f.post(address!, value)
      expect(response.status).toBe(403); expect((await response.json()).code).toBe('invite_invalid')
    }
    expect(await consumed(code)).toBe(false)
  })
  it.each(['revoked', 'expired'])('rejects %s grants using the same invalid response', async (state) => {
    const target = email(); const code = await grant(target)
    if (state === 'revoked') await prisma.$executeRaw`UPDATE signup_admission_test_grants SET revoked = TRUE WHERE id = ${code}`
    else await prisma.$executeRaw`UPDATE signup_admission_test_grants SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${code}`
    const response = await fixture({ authorizeSignUp: admission }).post(target, code)
    expect(response.status).toBe(403); expect((await response.json()).code).toBe('invite_invalid')
    expect(await consumed(code)).toBe(false)
  })
  it('rechecks revocation within consumption after preflight has allowed it', async () => {
    const target = email(); const code = await grant(target)
    const f = fixture({ authorizeSignUp: async (input) => {
      const decision = await admission(input)
      if (!decision.ok) return decision
      return { ok: true, consumeInvite: async (tx) => {
        await tx.$executeRaw`UPDATE signup_admission_test_grants SET revoked = TRUE WHERE id = ${code}`
        await decision.consumeInvite!(tx)
      } }
    } })
    const response = await f.post(target, code)
    expect(response.status).toBe(403); expect((await response.json()).code).toBe('invite_invalid')
    expect(await consumed(code)).toBe(false); expect(await prisma.user.count({ where: { email: target } })).toBe(0)
  })
  it('rate limits before admission with a stable code', async () => {
    const authorizeSignUp = vi.fn(admission)
    const response = await fixture({ authorizeSignUp, admitSignUpAttempt: async () => ({ ok: false, code: 'rate_limited', retryAfter: 60 }) }).post(email())
    expect(response.status).toBe(429); expect((await response.json()).code).toBe('rate_limited')
    expect(response.headers.get('retry-after')).toBe('60'); expect(authorizeSignUp).not.toHaveBeenCalled()
  })
  it('rolls back consumption when the user insert fails', async () => {
    const target = email(); const code = await grant(target)
    const f = fixture({ authorizeSignUp: admission, createTransactionDatabaseAdapter: (tx) => (options: Parameters<ReturnType<typeof prismaAdapter>>[0]) => {
      const adapter = prismaAdapter(tx, { provider: 'postgresql' })(options)
      return { ...adapter, create: async (data: Parameters<typeof adapter.create>[0]) => {
        if (data.model === 'user') throw new Error('synthetic user insert failure')
        return adapter.create(data)
      } }
    } })
    expect((await f.post(target, code)).status).toBe(500)
    expect(await consumed(code)).toBe(false); expect(await prisma.user.count({ where: { email: target } })).toBe(0)
  })
  it('rolls back invite and user when subsequent account insertion fails', async () => {
    const target = email(); const code = await grant(target)
    const f = fixture({ authorizeSignUp: admission, createTransactionDatabaseAdapter: (tx) => (options: Parameters<ReturnType<typeof prismaAdapter>>[0]) => {
      const adapter = prismaAdapter(tx, { provider: 'postgresql' })(options)
      return { ...adapter, create: async (data: Parameters<typeof adapter.create>[0]) => {
        if (data.model === 'account') throw new Error('synthetic account insert failure')
        return adapter.create(data)
      } }
    } })
    expect((await f.post(target, code)).status).toBeGreaterThanOrEqual(400)
    expect(await consumed(code)).toBe(false); expect(await prisma.user.count({ where: { email: target } })).toBe(0)
  })
  it('rolls back both writes on PostgreSQL COMMIT failure', async () => {
    const target = email(); const code = await grant(target)
    const f = fixture({ authorizeSignUp: async (input) => {
      const decision = await admission(input)
      if (!decision.ok) return decision
      return { ok: true, consumeInvite: async (tx) => {
        await decision.consumeInvite!(tx)
        await tx.$executeRawUnsafe('CREATE TEMP TABLE admission_parent (id TEXT PRIMARY KEY) ON COMMIT DROP')
        await tx.$executeRawUnsafe('CREATE TEMP TABLE admission_failure (id TEXT REFERENCES admission_parent(id) DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP')
        await tx.$executeRaw`INSERT INTO admission_failure VALUES (${randomUUID()})`
      } }
    } })
    expect((await f.post(target, code)).status).toBeGreaterThanOrEqual(400)
    expect(await consumed(code)).toBe(false); expect(await prisma.user.count({ where: { email: target } })).toBe(0)
  })
  it('admits one concurrent use across independent auth instances', async () => {
    const target = email(); const code = await grant(target)
    const responses = await Promise.all([fixture({ authorizeSignUp: admission }), fixture({ authorizeSignUp: admission })].map((f) => f.post(target, code)))
    expect(responses.map((r) => r.status).sort()).toEqual([200, 403])
    expect((await responses.find((r) => r.status === 403)!.json()).code).toBe('invite_invalid')
    expect(await consumed(code)).toBe(true); expect(await prisma.user.count({ where: { email: target } })).toBe(1)
  })
  it('protects internal user creation and OAuth creation', async () => {
    const f = fixture({ authorizeSignUp: admission }); const context = await f.auth.$context
    await expect(context.internalAdapter.createUser({ email: email(), name: 'Direct', emailVerified: false })).rejects.toMatchObject({ body: { code: 'not_invited' } })
    await expect(context.internalAdapter.createOAuthUser({ email: email(), name: 'OAuth', emailVerified: true }, { providerId: 'google', accountId: randomUUID() })).rejects.toMatchObject({ body: { code: 'not_invited' } })
  })
  it('protects the actual social ID-token endpoint without blocking existing logins', async () => {
    const target = email(); const providerAccountId = randomUUID()
    const options = fixture({ authorizeSignUp: admission }).options
    const auth = betterAuth({ ...options, secret, logger: { disabled: true }, socialProviders: { google: {
      clientId: 'synthetic-client', clientSecret: 'synthetic-secret',
      verifyIdToken: async () => true,
      getUserInfo: async () => ({ user: { id: providerAccountId, email: target, name: 'Social Test', emailVerified: true }, data: {} }),
    } } })
    const signIn = () => auth.handler(new Request(`${origin}/api/auth/sign-in/social`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', idToken: { token: 'synthetic-verified-token' } }),
    }))
    expect((await signIn()).status).toBeGreaterThanOrEqual(400)
    expect(await prisma.user.count({ where: { email: target } })).toBe(0)
    const context = await fixture({ authorizeSignUp: async () => ({ ok: true }) }).auth.$context
    await context.internalAdapter.createOAuthUser({ email: target, name: 'OAuth', emailVerified: true }, { providerId: 'google', accountId: providerAccountId })
    expect((await signIn()).status).toBe(200)
  })
  it('allows admitted OAuth user and account creation', async () => {
    const target = email(); const context = await fixture({ authorizeSignUp: async () => ({ ok: true }) }).auth.$context
    const result = await context.internalAdapter.createOAuthUser({ email: target, name: 'OAuth', emailVerified: true }, { providerId: 'google', accountId: randomUUID() })
    expect(result.user.email).toBe(target); expect(await prisma.account.count({ where: { userId: result.user.id } })).toBe(1)
  })
})

import { runWithTransaction } from '@better-auth/core/context'
import type { Prisma } from '../../../generated/prisma/client'
describe('independent review probes', () => {
 it('counts once per successful request with concurrent requests on the SAME auth instance and distinct codes', async () => {
   const attempts = vi.fn(async () => ({ok: true as const}))
   const f = fixture({authorizeSignUp: admission, admitSignUpAttempt: attempts})
   const a = email(), b = email(); const ca = await grant(a), cb = await grant(b)
   const results = await Promise.all([f.post(a, ca), f.post(b, cb)])
   expect(results.map(r=>r.status)).toEqual([200,200]); expect(attempts).toHaveBeenCalledTimes(2)
   expect(await consumed(ca)).toBe(true); expect(await consumed(cb)).toBe(true)
 })
 it('counts oversized-code attempts before rate denial', async () => {
   const attempts = vi.fn(async () => ({ok:false as const, code:'rate_limited' as const}))
   const f = fixture({authorizeSignUp: admission, admitSignUpAttempt: attempts})
   const response = await f.post(email(), 'X'.repeat(65))
   expect(response.status).toBe(429); expect((await response.json()).code).toBe('rate_limited')
   expect(attempts).toHaveBeenCalledTimes(1)
 })
 it('measures exact transaction and connection identity for consumption and all native signup inserts', async () => {
   const target = email(), code = await grant(target); const ids: string[] = []
   const identify = async(tx: Prisma.TransactionClient) => { const rows=await tx.$queryRawUnsafe<{pid:number;xid:string}[]>('SELECT pg_backend_pid() pid, txid_current()::text xid'); ids.push(`${rows[0]!.pid}:${rows[0]!.xid}`) }
   const f=fixture({authorizeSignUp: async(input) => {
      const decision=await admission(input); if(!decision.ok) return decision;
      return {ok:true,consumeInvite: async(tx)=>{await identify(tx); await decision.consumeInvite!(tx)}}
   },createTransactionDatabaseAdapter:(tx)=>(options: BetterAuthOptions)=>{
      const adapter=prismaAdapter(tx,{provider:'postgresql'})(options)
      return {...adapter,create:async(data: Parameters<typeof adapter.create>[0])=>{await identify(tx); return adapter.create(data)}}
   }})
   expect((await f.post(target,code)).status).toBe(200)
   expect(ids).toHaveLength(4); expect(new Set(ids).size).toBe(1)
 })
 it('rolls nested OAuth creation back with its enclosing transaction', async () => {
   const target=email(); const code=await grant(target)
   const f=fixture({authorizeSignUp: async({email: address})=>admission({email:address,inviteCode:code.toUpperCase()})})
   const context=await f.auth.$context
   await expect(runWithTransaction(context.adapter as DBAdapter,async()=>{
      await context.internalAdapter.createOAuthUser({email:target,name:'Nested',emailVerified:true},{providerId:'google',accountId:randomUUID()})
      throw new Error('outer rollback')
   })).rejects.toThrow()
   expect(await consumed(code)).toBe(false)
   expect(await prisma.user.count({where:{email:target}})).toBe(0)
 })
 it('preserves implicit verified social linking to an existing credential account without admission', async()=>{
   const target=email(); await fixture().post(target); const calls=vi.fn(admission)
   const options=fixture({authorizeSignUp:calls}).options
   const auth=betterAuth({...options,secret,logger:{disabled:true},socialProviders:{google:{clientId:'synthetic',clientSecret:'synthetic',verifyIdToken:async()=>true,getUserInfo:async()=>({user:{id:randomUUID(),email:target,name:'Link',emailVerified:true},data:{}})}}})
   const response=await auth.handler(new Request(`${origin}/api/auth/sign-in/social`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({provider:'google',idToken:{token:'synthetic'}})}))
   expect(response.status).toBe(200); expect(calls).not.toHaveBeenCalled()
   const user=await prisma.user.findUniqueOrThrow({where:{email:target}})
   expect(await prisma.account.count({where:{userId:user.id}})).toBe(2)
 })
})

it('allows allowlisted emails with oversized codes', async()=>{
 const allow=vi.fn(async()=>({ok:true as const})); const f=fixture({authorizeSignUp:allow}); const response=await f.post(email(),'X'.repeat(65));
 expect(response.status).toBe(200); expect(allow).toHaveBeenCalledTimes(2);
})


describe.skipIf(!local)('invalid input handler ordering', () => {
  it.each(['body', 'header'] as const)('counts and admits bounded invalid %s codes before lookup', async (transport) => {
    for (const value of ['X'.repeat(65), 'X' + ' '.repeat(100) + 'VALID']) {
      const target = email(); const code = await grant(target)
      const send = (f: ReturnType<typeof fixture>) => f.post(target, transport === 'body' ? value : undefined, transport === 'header' ? { 'x-quits-invite': value } : {})
      const lookup = vi.fn()
      const adapterHook: AuthHooks['createDatabaseAdapter'] = (client) => (options: BetterAuthOptions) => {
        const adapter = prismaAdapter(client, { provider: 'postgresql' })(options)
        return { ...adapter, findOne: async (data: Parameters<typeof adapter.findOne>[0]) => { if (data.model === 'user') lookup(); return adapter.findOne(data) } }
      }
      const deniedAttempts = vi.fn(async () => ({ ok: false as const, code: 'rate_limited' as const }))
      const authorize = vi.fn(admission)
      const limited = await send(fixture({ authorizeSignUp: authorize, admitSignUpAttempt: deniedAttempts, createDatabaseAdapter: adapterHook }))
      expect(limited.status).toBe(429); expect((await limited.json()).code).toBe('rate_limited')
      expect(deniedAttempts).toHaveBeenCalledTimes(1); expect(authorize).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled()
      const attempts = vi.fn(async () => ({ ok: true as const }))
      const invalid = await send(fixture({ authorizeSignUp: admission, admitSignUpAttempt: attempts, createDatabaseAdapter: adapterHook }))
      expect(invalid.status).toBe(403); expect((await invalid.json()).code).toBe('invite_invalid')
      expect(attempts).toHaveBeenCalledTimes(1); expect(lookup).not.toHaveBeenCalled(); expect(await consumed(code)).toBe(false)
      const allowedAttempts = vi.fn(async () => ({ ok: true as const }))
      const allow = vi.fn(async () => ({ ok: true as const }))
      expect((await send(fixture({ authorizeSignUp: allow, admitSignUpAttempt: allowedAttempts }))).status).toBe(200)
      expect(allowedAttempts).toHaveBeenCalledTimes(1); expect(allow).toHaveBeenCalledTimes(2)
      expect(allowedAttempts.mock.calls[0]).toMatchObject([{ email: target, inviteCodeInvalid: true }])
    }
  })
  it('never consumes a grant returned for invalid input', async () => {
    const consumeInvite = vi.fn(async () => {})
    const response = await fixture({ authorizeSignUp: async () => ({ ok: true, consumeInvite }) }).post(email(), 'X'.repeat(65))
    expect(response.status).toBe(403); expect((await response.json()).code).toBe('invite_invalid'); expect(consumeInvite).not.toHaveBeenCalled()
  })
  it('treats whitespace-only body input as invalid and preserves open defaults', async () => {
    expect((await fixture({ authorizeSignUp: admission }).post(email(), ' '.repeat(64))).status).toBe(403)
    expect((await fixture().post(email(), 'X'.repeat(65))).status).toBe(200)
  })
})

describe.skipIf(!local)('owned nested transaction lifecycle', () => {
  it.each(['rollback', 'commit', 'commit-failure'] as const)('defers nested OAuth and internal after-hooks until outer %s', async (outcome) => {
    const target = email(); const code = await grant(target); const direct = email()
    const after = vi.fn(async (user: { email: string }) => {
      expect(await prisma.user.count({ where: { email: user.email } })).toBe(1)
    })
    const context = await fixture({ authorizeSignUp: async ({ email: address }) => address === direct ? { ok: true } : admission({ email: address, inviteCode: code.toUpperCase() }).then(decision => {
      if (!decision.ok || outcome !== 'commit-failure') return decision
      return { ok: true, consumeInvite: async tx => {
        await decision.consumeInvite!(tx)
        await tx.$executeRawUnsafe('CREATE TEMP TABLE nested_parent (id TEXT PRIMARY KEY) ON COMMIT DROP')
        await tx.$executeRawUnsafe('CREATE TEMP TABLE nested_failure (id TEXT REFERENCES nested_parent(id) DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP')
        await tx.$executeRaw`INSERT INTO nested_failure VALUES (${randomUUID()})`
      } }
    }) }, undefined, { user: { create: { after } } }).auth.$context
    const accountId = randomUUID()
    const operation = runWithTransaction(context.adapter as DBAdapter, async () => {
      await context.internalAdapter.createOAuthUser({ email: target, name: 'Nested', emailVerified: true }, { providerId: 'google', accountId })
      await context.internalAdapter.createUser({ email: direct, name: 'Internal', emailVerified: false })
      expect(after).not.toHaveBeenCalled()
      if (outcome === 'rollback') throw new Error('outer rollback')

    })
    if (outcome === 'commit') { await operation; expect(after).toHaveBeenCalledTimes(2) }
    else { await expect(operation).rejects.toThrow(); expect(after).not.toHaveBeenCalled() }
    expect(await consumed(code)).toBe(outcome === 'commit')
    expect(await prisma.user.count({ where: { email: { in: [target, direct] } } })).toBe(outcome === 'commit' ? 2 : 0)
    expect(await prisma.account.count({ where: { accountId } })).toBe(outcome === 'commit' ? 1 : 0)
  })
  it('rejects another auth instance ambient transaction before writes', async () => {
    const target = email(); const code = await grant(target)
    const hooks: AuthHooks = { authorizeSignUp: async ({ email: address }) => admission({ email: address, inviteCode: code.toUpperCase() }) }
    const first = await fixture(hooks).auth.$context; const second = await fixture(hooks).auth.$context
    await expect(runWithTransaction(first.adapter as DBAdapter, () => second.internalAdapter.createOAuthUser({ email: target, name: 'Foreign', emailVerified: true }, { providerId: 'google', accountId: randomUUID() }))).rejects.toMatchObject({ body: { code: 'signup_failed' } })
    expect(await consumed(code)).toBe(false); expect(await prisma.user.count({ where: { email: target } })).toBe(0)
  })
})


describe.skipIf(!local)('nested transaction isolation', () => {
  it.each(['same', 'separate'] as const)('isolates overlapping nested requests on %s auth instances', async (instances) => {
    const targets = [email(), email()]; const codes = await Promise.all(targets.map(grant))
    const attempts = vi.fn(async () => ({ ok: true as const }))
    const after = vi.fn(async (user: { email: string }) => {
      expect(user.email).toBe(targets[1]); expect(await prisma.user.count({ where: { email: user.email } })).toBe(1)
    })
    const hooks: AuthHooks = { admitSignUpAttempt: attempts, authorizeSignUp: ({ email: address }) => admission({ email: address, inviteCode: codes[targets.indexOf(address)]!.toUpperCase() }) }
    const first = await fixture(hooks, undefined, { user: { create: { after } } }).auth.$context
    const second = instances === 'same' ? first : await fixture(hooks, undefined, { user: { create: { after } } }).auth.$context
    let arrive = 0; let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const operations = [first, second].map((context, index) => runWithTransaction(context.adapter as DBAdapter, async () => {
      await context.internalAdapter.createOAuthUser({ email: targets[index]!, name: 'Concurrent', emailVerified: true }, { providerId: 'google', accountId: randomUUID() })
      expect(after).not.toHaveBeenCalled()
      if (++arrive === 2) release()
      await barrier
      if (index === 0) throw new Error('one outer rollback')
    }))
    const results = await Promise.allSettled(operations)
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled'])
    expect(attempts).toHaveBeenCalledTimes(2); expect(after).toHaveBeenCalledTimes(1)
    expect(await consumed(codes[0]!)).toBe(false); expect(await consumed(codes[1]!)).toBe(true)
    expect(await prisma.user.count({ where: { email: targets[0] } })).toBe(0)
    expect(await prisma.user.count({ where: { email: targets[1] } })).toBe(1)
  })
  it('rolls back when a caller catches a failed nested operation', async () => {
    const target = email(); const code = await grant(target)
    const context = await fixture({ authorizeSignUp: () => admission({ email: target, inviteCode: code.toUpperCase() }) }).auth.$context
    await expect(runWithTransaction(context.adapter as DBAdapter, async () => {
      await runWithTransaction(context.adapter as DBAdapter, async () => {
        await context.internalAdapter.createOAuthUser({ email: target, name: 'Caught', emailVerified: true }, { providerId: 'google', accountId: randomUUID() })
        throw new Error('nested failure')
      }).catch(() => {})
    })).rejects.toMatchObject({ body: { code: 'signup_failed' } })
    expect(await consumed(code)).toBe(false); expect(await prisma.user.count({ where: { email: target } })).toBe(0)
  })
})
