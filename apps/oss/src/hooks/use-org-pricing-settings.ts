import { useEffect, useState } from "react"
import { trpc } from "../trpc/client"

export function useOrgPricingSettings() {
  const [pricesIncludeTax, setPricesIncludeTax] = useState(false)
  useEffect(() => {
    let cancelled = false
    trpc.settings.get.query().then((settings) => { if (!cancelled) setPricesIncludeTax(settings.pricesIncludeTax) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  return { pricesIncludeTax }
}
