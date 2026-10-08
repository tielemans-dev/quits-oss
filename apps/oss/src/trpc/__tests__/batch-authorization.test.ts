import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { beforeEach, expect, it, vi } from 'vitest'
import { createRequestContext, authorizedProcedure, router, type Context } from '../init'

const membership = vi.hoisted(() => vi.fn())
vi.mock('../../lib/db', () => ({ prisma: { member: { findFirst: membership } } }))
vi.mock('../../lib/auth', () => ({ auth: {} }))

const testRouter = router({
  invoice: authorizedProcedure('invoice:read').query(({ ctx }) => ctx.actor.roles),
  settings: authorizedProcedure('settings:read').query(({ ctx }) => ctx.actor.roles),
  contact: authorizedProcedure('contact:read').query(({ ctx }) => ctx.actor.roles),
})
const session = { user: { id: 'u1', name: 'User' }, session: { activeOrganizationId: 'org1' } } as Context['session']
async function batch(requestedOrganizationId: string | null = 'org1') {
  const response = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req: new Request('http://localhost/api/trpc/invoice,settings,contact?batch=1'),
    router: testRouter,
    createContext: async () => createRequestContext(session, requestedOrganizationId),
  })
  return { status: response.status, body: await response.json() }
}
beforeEach(() => { membership.mockReset(); membership.mockResolvedValue({ role: 'admin' }) })

it('shares one in-flight membership lookup across the HTTP query batch', async () => {
  expect((await batch()).status).toBe(200)
  expect(membership).toHaveBeenCalledTimes(1)
})

it('rechecks membership on the next request, even if the session object is reused', async () => {
  expect((await batch()).status).toBe(200)
  membership.mockResolvedValue(null)
  expect((await batch()).status).toBe(403)
  expect(membership).toHaveBeenCalledTimes(2)
})

it('rejects a mismatched organization before reading or reusing membership', async () => {
  expect((await batch('other-org')).status).toBe(409)
  expect(membership).not.toHaveBeenCalled()
})

it('retries a failed membership read on a later request', async () => {
  membership.mockRejectedValue(new Error('database unavailable'))
  expect((await batch()).status).toBe(500)
  membership.mockResolvedValue({ role: 'admin' })
  expect((await batch()).status).toBe(200)
  expect(membership).toHaveBeenCalledTimes(2)
})

it('does not reuse query authorization for mutations in the same server caller context', async () => {
  const mutationRouter = router({
    read: authorizedProcedure('invoice:read').query(() => 'read'),
    write: authorizedProcedure('invoice:create').mutation(() => 'written'),
  })
  const caller = mutationRouter.createCaller(createRequestContext(session, 'org1'))
  await expect(caller.read()).resolves.toBe('read')
  membership.mockResolvedValue(null)
  await expect(caller.write()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(membership).toHaveBeenCalledTimes(2)
})
