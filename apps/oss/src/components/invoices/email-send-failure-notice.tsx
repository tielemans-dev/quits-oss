import { AlertTriangle } from "lucide-react"
import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"

/**
 * Shown on the invoice when its email did not go out. The text is ours and never the provider's:
 * what the provider said stays in the server logs. The invoice itself is saved as it was, so the
 * only next step is to try the email again.
 */
export function EmailSendFailureNotice({ onRetry, disabled }: { onRetry: () => void; disabled?: boolean }) {
  const { t } = useI18n()
  return (
    <div
      role="alert"
      className="no-print mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-tone-warning/30 bg-tone-warning/14 px-4 py-3 text-sm text-foreground"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-tone-warning" aria-hidden="true" />
        <div>
          <p className="font-medium">{t("invoices.detail.email.sendFailed.title")}</p>
          <p>{t("invoices.detail.email.sendFailed.body")}</p>
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={disabled}>
        {t("invoices.detail.email.sendFailed.retry")}
      </Button>
    </div>
  )
}
