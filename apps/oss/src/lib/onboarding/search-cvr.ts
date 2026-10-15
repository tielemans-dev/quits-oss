import { isValidDanishCvr } from "@quits/contracts/onboarding"

export type CvrLookupCompany = {
  cvr: string
  name: string
  address: string
  active?: boolean
}

export type CvrLookupContext = {
  userId: string
  signal: AbortSignal
}

/** Cloud supplies the registry client. Self-hosted installs have no lookup. */
export type CvrLookupProvider = {
  search(query: string, context: CvrLookupContext): Promise<Array<CvrLookupCompany & { status: string; statusClass: string }>>
}

export async function searchOwnCvr(input: {
  query: string
  cloud: boolean
  userId: string
  lookup?: CvrLookupProvider
  signal?: AbortSignal
}): Promise<{ available: boolean; companies: CvrLookupCompany[] }> {
  if (!input.cloud || !input.lookup) return { available: false, companies: [] }
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(8_000)])
  signal.throwIfAborted()
  const companies = await input.lookup.search(input.query, {
    userId: input.userId,
    signal,
  })
  return {
    available: true,
    companies: companies
      .filter((company) => isValidDanishCvr(company.cvr) && company.name.trim().length > 0)
      .slice(0, 8)
      .map((company) => ({
        cvr: company.cvr,
        name: company.name.trim().slice(0, 120),
        address: company.address.trim().slice(0, 240),
        ...(company.status !== "active" || company.statusClass !== "active" ? { active: false as const } : {}),
      })),
  }
}
