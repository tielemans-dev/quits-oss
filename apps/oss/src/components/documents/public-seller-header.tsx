import { useState } from "react"
import { useI18n } from "../../lib/i18n/react"
import type { PublicSeller } from "../../lib/documents/public-presentation"

/**
 * Who a document opened from a link comes from: the seller's logo and company name.
 * Renders nothing when the seller has neither, so no product name ever stands in for them.
 */
export function PublicSellerHeader({ seller }: { seller: PublicSeller }) {
  const { t } = useI18n()
  const [logoFailed, setLogoFailed] = useState(false)
  const logo = seller.logo && !logoFailed ? seller.logo : null

  if (!logo && !seller.name) return null

  return (
    <header className="flex items-center gap-3">
      {logo ? (
        <img
          src={logo}
          // The name next to the logo says who it is; without one the image has to.
          alt={seller.name ? "" : t("invoices.detail.companyLogoAlt")}
          // The page address carries the access token: never hand it to the host of a logo.
          referrerPolicy="no-referrer"
          onError={() => setLogoFailed(true)}
          className="h-12 w-auto max-w-40 object-contain"
        />
      ) : null}
      {seller.name ? <p className="text-lg font-semibold">{seller.name}</p> : null}
    </header>
  )
}
