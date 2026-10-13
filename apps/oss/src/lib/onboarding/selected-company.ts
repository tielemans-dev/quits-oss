import type { CvrLookupCompany } from './search-cvr'

function key(userId: string, organizationId: string) {
  return `quits:onboarding:selected-company:v1:${userId}:${organizationId}`
}

/** Tab-local handoff across the organization switch, never registry trust metadata. */
export function stageSelectedCompany(userId: string, organizationId: string, company: CvrLookupCompany) {
  sessionStorage.setItem(key(userId, organizationId), JSON.stringify(company))
}

export function readSelectedCompany(userId: string, organizationId: string): CvrLookupCompany | null {
  const raw = sessionStorage.getItem(key(userId, organizationId))
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (typeof value.name === 'string' && value.name.trim() && value.name.length <= 120 &&
      typeof value.address === 'string' && value.address.length <= 240 &&
      typeof value.cvr === 'string' && /^\d{8}$/.test(value.cvr)) return value
  } catch { /* Ignore malformed tab state. */ }
  clearSelectedCompany(userId, organizationId)
  return null
}

export function clearSelectedCompany(userId: string, organizationId: string) {
  sessionStorage.removeItem(key(userId, organizationId))
}
