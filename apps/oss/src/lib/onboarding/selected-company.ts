import type { CvrLookupCompany } from './search-cvr'

function key(userId: string, organizationId: string) {
  return `quits:onboarding:selected-company:v1:${userId}:${organizationId}`
}

export type StagedCompany = {
  name: string
  address: string
  /** Eight digits from a CVR result, or empty when the name was typed by hand. */
  cvr: string
}

/** Tab-local handoff across the organization switch, never registry trust metadata. */
export function stageSelectedCompany(
  userId: string,
  organizationId: string,
  company: Pick<CvrLookupCompany, 'name'> & Partial<Pick<CvrLookupCompany, 'address' | 'cvr'>>,
) {
  const name = company.name.trim()
  const address = company.address?.trim() ?? ''
  const cvr = company.cvr?.trim() ?? ''
  if (!name || name.length > 120 || address.length > 240 || (cvr !== '' && !/^\d{8}$/.test(cvr))) return
  sessionStorage.setItem(key(userId, organizationId), JSON.stringify({ name, address, cvr } satisfies StagedCompany))
}

export function readSelectedCompany(userId: string, organizationId: string): StagedCompany | null {
  const raw = sessionStorage.getItem(key(userId, organizationId))
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    const cvr = typeof value.cvr === 'string' ? value.cvr : ''
    if (typeof value.name === 'string' && value.name.trim() && value.name.length <= 120 &&
      typeof value.address === 'string' && value.address.length <= 240 &&
      (cvr === '' || /^\d{8}$/.test(cvr))) {
      return { name: value.name, address: value.address, cvr }
    }
  } catch { /* Ignore malformed tab state. */ }
  clearSelectedCompany(userId, organizationId)
  return null
}

export function clearSelectedCompany(userId: string, organizationId: string) {
  sessionStorage.removeItem(key(userId, organizationId))
}
