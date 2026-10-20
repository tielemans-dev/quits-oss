import { normalizeCurrency } from "../lib/i18n/locale"
import { useOrgSettings } from "./use-org-settings"

type CurrencySettings = {
  defaultCurrency?: string | null
  currency?: string | null
}

export function resolveOrgCurrency(settings?: CurrencySettings | null): string {
  return normalizeCurrency(settings?.defaultCurrency ?? settings?.currency ?? null)
}

/** The organization's currency, with the fallback currency until its settings load. */
export function useOrgCurrency() {
  return resolveOrgCurrency(useOrgSettings())
}
