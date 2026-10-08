import { Check, Loader2 } from "lucide-react"

import { Button } from "../ui/button"
import { cn } from "../../lib/utils"
import { useI18n } from "../../lib/i18n/react"
import type { ReminderState } from "./use-reminders"

/**
 * The reminder action of a row. Idle, it is a button; while sending, a disabled one; once sent, a
 * quiet confirmation in place of the button; after a refusal, the server's reason beside a button
 * to try again. Delivery that is queued or unconfirmed says so rather than "sent".
 */
export function RemindAction({
  state,
  onRemind,
  size = "sm",
  variant = "outline",
  className,
}: {
  state: ReminderState | undefined
  onRemind: () => void
  size?: "sm" | "xs"
  /** `link` is a line of text for dense rows; it takes no more height than the line it sits on. */
  variant?: "outline" | "link"
  className?: string
}) {
  const { t } = useI18n()

  if (state?.status === "sent") {
    const warning = state.delivery === "unconfirmed"
    const label =
      state.delivery === "pending"
        ? t("dashboard.remind.pending")
        : warning
          ? t("dashboard.remind.unconfirmed")
          : t("dashboard.remind.sent")
    return (
      <span
        role="status"
        className={cn(
          "inline-flex items-center gap-1.5 text-xs font-semibold",
          warning ? "text-tone-warning" : "text-tone-success",
          className
        )}
      >
        <Check aria-hidden="true" className="size-3.5" />
        {label}
      </span>
    )
  }

  const sending = state?.status === "sending"
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-3 gap-y-1", className)}>
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={sending}
        onClick={onRemind}
        className={variant === "link" ? "h-auto p-0 text-xs font-semibold" : undefined}
      >
        {sending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {sending ? t("dashboard.remind.sending") : t("dashboard.attention.action.remind")}
      </Button>
      {state?.status === "error" ? (
        <span role="alert" className="text-tone-danger text-xs">
          {state.message ?? t("dashboard.remind.error")}
        </span>
      ) : null}
    </span>
  )
}
