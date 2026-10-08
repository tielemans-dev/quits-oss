import { RotateCw } from "lucide-react"
import { useOrganizationChanged } from "../lib/active-organization"
import { useI18n } from "../lib/i18n/react"
import { reloadPage } from "../lib/page-navigation"
import { Button } from "./ui/button"

/**
 * Shown on every page once the server rejected a request because the active organization was
 * changed in another tab: this page still acts for the previous one until it is reloaded.
 */
export function OrganizationChangedBanner() {
  const { t } = useI18n()
  const changed = useOrganizationChanged()
  if (!changed) return null
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-tone-warning/30 bg-tone-warning/10 px-4 py-3 text-sm text-foreground"
    >
      <p>{t("ui.organizationChanged.message")}</p>
      <Button type="button" variant="outline" size="sm" onClick={() => reloadPage()}>
        <RotateCw className="mr-2 h-4 w-4" />
        {t("ui.organizationChanged.action")}
      </Button>
    </div>
  )
}
