import { getRequestOrganizationId } from './active-organization'
import { trpc } from '../trpc/client'

type Settings = Awaited<ReturnType<typeof trpc.settings.get.query>>
const pending = new Map<string, Promise<Settings>>()

/** Share concurrent reads, never settled data. Settings mutations need no cache invalidation. */
export function loadOrganizationSettings(): Promise<Settings> {
  if (import.meta.env.SSR) return trpc.settings.get.query()
  const organizationId = getRequestOrganizationId()
  if (!organizationId) return Promise.reject(new Error('No request organization selected'))
  const existing = pending.get(organizationId)
  if (existing) return existing
  const query = trpc.settings.get.query()
  pending.set(organizationId, query)
  const forget = () => { if (pending.get(organizationId) === query) pending.delete(organizationId) }
  void query.then(forget, forget)
  return query
}
