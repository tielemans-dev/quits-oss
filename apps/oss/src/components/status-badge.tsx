import type { ReactNode } from "react"

import { useI18n } from "../lib/i18n/react"
import { cn } from "../lib/utils"
import {
  getStatusLabel,
  getStatusTone,
  type StatusDomain,
  type StatusTone,
} from "../lib/status-tones"

/** Text and dot in the tone colour, on the tone at 12% (18% in dark mode); see styles.css. */
const toneClassName: Record<StatusTone, string> = {
  neutral: "text-tone-neutral bg-tone-neutral/12 dark:bg-tone-neutral/18",
  info: "text-tone-info bg-tone-info/12 dark:bg-tone-info/18",
  progress: "text-tone-progress bg-tone-progress/12 dark:bg-tone-progress/18",
  success: "text-tone-success bg-tone-success/12 dark:bg-tone-success/18",
  warning: "text-tone-warning bg-tone-warning/12 dark:bg-tone-warning/18",
  danger: "text-tone-danger bg-tone-danger/12 dark:bg-tone-danger/18",
  muted: "text-tone-muted bg-tone-muted/12 dark:bg-tone-muted/18",
}

/** A badge for a tone with a label the caller has already translated. */
export function ToneBadge({
  tone,
  children,
  className,
}: {
  tone: StatusTone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={cn(
        "inline-flex h-5.5 w-fit shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap",
        toneClassName[tone],
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          // Muted and neutral differ in shape, not colour: muted is a ring, neutral a solid dot.
          tone === "muted" ? "border-[1.5px] border-current" : "bg-current"
        )}
      />
      {children}
    </span>
  )
}

/**
 * The badge for a status of a domain (see `statusTones`): its tone, and its label in the current
 * language. A status this client does not know shows as it is, in the neutral tone.
 */
export function StatusBadge({
  domain,
  status,
  className,
}: {
  domain: StatusDomain
  status: string
  className?: string
}) {
  const { t } = useI18n()
  return (
    <ToneBadge tone={getStatusTone(domain, status)} className={className}>
      {getStatusLabel(t, domain, status)}
    </ToneBadge>
  )
}
