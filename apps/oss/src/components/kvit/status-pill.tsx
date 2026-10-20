import type { ReactNode } from "react"

import type { StatusTone } from "../../lib/status-tones"
import { cn } from "../../lib/utils"

/**
 * Four looks for the seven tones: green for settled, amber for what needs attention, red for what
 * failed, and one quiet neutral for everything else, so a list screen shows three colours at most.
 * Each is the label in the tone on the tone at 10% (see styles.css).
 */
const toneClassName: Record<StatusTone, string> = {
  neutral: "text-muted-foreground bg-(--neutral-6)",
  info: "text-muted-foreground bg-(--neutral-6)",
  progress: "text-muted-foreground bg-(--neutral-6)",
  muted: "text-muted-foreground bg-(--neutral-6)",
  success: "text-tone-success bg-tone-success-soft",
  warning: "text-tone-warning bg-tone-warning-soft",
  danger: "text-tone-danger bg-tone-danger-soft",
}

/**
 * The status badge for a tone, with a label the caller has already translated. Status colours
 * live only here. `StatusBadge` is this badge for a status of a domain.
 *
 * The label is always text, so colour is never the only signal.
 */
export function StatusPill({
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
        "inline-flex h-5 w-fit shrink-0 items-center rounded-sm px-1.5 text-xs font-medium whitespace-nowrap",
        toneClassName[tone],
        className
      )}
    >
      {children}
    </span>
  )
}
