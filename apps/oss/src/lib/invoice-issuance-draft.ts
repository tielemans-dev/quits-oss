import { getRequestOrganizationId } from "./active-organization"
import type { IssuanceValues } from "../components/invoices/issuance-fields"

type Valuation = Pick<IssuanceValues, "exchangeRate" | "rateDate">
// UI inputs only: the send command remains responsible for validating and freezing valuation.
// Keep them across Settings/navigation in this tab, without changing the persisted draft model.
const fallback = new Map<string, Valuation>()
function key(id: string, currency: string, baseCurrency?: string): string | undefined {
  const organizationId = getRequestOrganizationId()
  if (typeof window === "undefined" || !organizationId || !baseCurrency || currency === baseCurrency) return
  return `quits:invoice-issuance:${JSON.stringify([organizationId, id, currency, baseCurrency])}`
}
export function retainDraftValuation(id: string, currency: string, baseCurrency: string | undefined, value: Valuation) {
  const storageKey = key(id, currency, baseCurrency)
  if (!storageKey) return
  const valuation = { exchangeRate: value.exchangeRate, rateDate: value.rateDate }
  fallback.set(storageKey, valuation)
  try { window.sessionStorage.setItem(storageKey, JSON.stringify(valuation)) } catch { /* Keep navigation working when browser storage is unavailable. */ }
}
export function readDraftValuation(id: string, currency: string, baseCurrency?: string): Valuation | undefined {
  const storageKey = key(id, currency, baseCurrency)
  if (!storageKey) return
  try {
    const raw = window.sessionStorage.getItem(storageKey)
    if (raw) {
      const value: unknown = JSON.parse(raw)
      if (value && typeof value === "object" && "exchangeRate" in value && "rateDate" in value && typeof value.exchangeRate === "string" && typeof value.rateDate === "string") {
        return { exchangeRate: value.exchangeRate, rateDate: value.rateDate }
      }
    }
  } catch { /* Use the in-memory copy if storage cannot be read. */ }
  return fallback.get(storageKey)
}
export function clearDraftValuation(id: string, currency: string, baseCurrency?: string) {
  const storageKey = key(id, currency, baseCurrency)
  if (!storageKey) return
  fallback.delete(storageKey)
  try { window.sessionStorage.removeItem(storageKey) } catch { /* Storage may be disabled. */ }
}
