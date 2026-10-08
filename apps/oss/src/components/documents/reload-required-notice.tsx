import { RotateCw } from "lucide-react"
import type { PollFailure } from "../../hooks/use-poll-while"
import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"

/**
 * Shown when following a document stopped for good, for example because the organization was
 * switched in another tab: the server's reason and a way to reload the page.
 */
export function ReloadRequiredNotice({ failure }: { failure: PollFailure | null }) {
  const { t } = useI18n()
  if (!failure) return null
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-tone-warning/30 bg-tone-warning/10 px-4 py-3 text-sm text-foreground"
    >
      <div>
        <p className="font-medium">{t("ui.reloadRequired.title")}</p>
        <p>{failure.message}</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
        <RotateCw className="mr-2 h-4 w-4" />
        {t("ui.reloadRequired.action")}
      </Button>
    </div>
  )
}
