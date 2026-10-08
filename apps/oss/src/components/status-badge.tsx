import type { ReactNode } from "react"

import { useI18n } from "../lib/i18n/react"
import { cn } from "../lib/utils"
import {
  getStatusLabel,
  getStatusTone,
  type StatusDomain,
  type StatusTone,
} from "../lib/status-tones"

/** A soft pill: the label and dot in the tone colour at full strength, on the tone at 14%; see styles.css. */
const toneClassName: Record<StatusTone, string> = {
  neutral: "text-tone-neutral bg-tone-neutral/14",
  info: "text-tone-info bg-tone-info/14",
  progress: "text-tone-progress bg-tone-progress/14",
  success: "text-tone-success bg-tone-success/14",
  warning: "text-tone-warning bg-tone-warning/14",
  danger: "text-tone-danger bg-tone-danger/14",
  muted: "text-tone-muted bg-tone-muted/14",
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
        "inline-flex h-5.5 w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap",
        toneClassName[tone],
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
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
