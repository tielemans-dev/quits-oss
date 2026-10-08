import { Link } from "@tanstack/react-router"
import { Check, Loader2 } from "lucide-react"

import { Button } from "../ui/button"
import { cn } from "../../lib/utils"
import { useI18n } from "../../lib/i18n/react"
import type { TranslationKey } from "../../lib/i18n/messages"
import type { ReminderFailure, ReminderState } from "./use-reminders"

const FAILURE_KEY = {
  alreadyReminded: "dashboard.remind.error.alreadyReminded",
  noRecipient: "dashboard.remind.error.noRecipient",
  emailUnavailable: "dashboard.remind.error.emailUnavailable",
  emailProviderRefused: "dashboard.remind.error.emailProviderRefused",
  emailProviderUnreachable: "dashboard.remind.error.emailProviderUnreachable",
  notRemindable: "dashboard.remind.error.notRemindable",
  forbidden: "dashboard.remind.error.forbidden",
  notFound: "dashboard.remind.error.notFound",
  unknown: "dashboard.remind.error",
} as const satisfies Record<ReminderFailure, TranslationKey>

/** Refusals that the email settings can fix. */
const SETTINGS_FIXES: ReadonlySet<ReminderFailure> = new Set([
  "emailUnavailable",
  "emailProviderRefused",
  "emailProviderUnreachable",
])

/** The refusal in words, from the catalogue: the server's own text is never shown. */
export function ReminderFailureNote({ failure, className }: { failure: ReminderFailure; className?: string }) {
  const { t } = useI18n()
  return (
    <span role="alert" className={cn("text-tone-danger text-xs", className)}>
      {t(FAILURE_KEY[failure])}
      {SETTINGS_FIXES.has(failure) ? (
        <>
          {" "}
          <Link to="/settings" className="font-semibold underline underline-offset-2">
            {t("dashboard.remind.settingsLink")}
          </Link>
        </>
      ) : null}
    </span>
  )
}

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
      {state?.status === "error" ? <ReminderFailureNote failure={state.failure} /> : null}
    </span>
  )
}
