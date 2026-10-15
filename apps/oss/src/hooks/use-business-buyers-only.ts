import { useEffect, useState } from "react"
import { trpc } from "../trpc/client"

/** True only when an adopter's issuance policy limits customers to businesses; ordinary installs accept consumers. */
export function useBusinessBuyersOnly(): boolean {
  const [businessOnly, setBusinessOnly] = useState(false)
  useEffect(() => {
    let cancelled = false
    trpc.invoices.sendReadiness.query().then(state => { if (!cancelled) setBusinessOnly(state.businessBuyersOnly) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  return businessOnly
}
