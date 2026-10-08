import type { ReactNode } from "react"

import type { StatusTone } from "../../lib/status-tones"
import { cn } from "../../lib/utils"

/** A soft pill: the label (and dot) in the tone at full strength, on the tone at 14%; see styles.css. */
const toneClassName: Record<StatusTone, string> = {
  neutral: "text-tone-neutral bg-tone-neutral/14",
  info: "text-tone-info bg-tone-info/14",
  progress: "text-tone-progress bg-tone-progress/14",
  success: "text-tone-success bg-tone-success/14",
  warning: "text-tone-warning bg-tone-warning/14",
  danger: "text-tone-danger bg-tone-danger/14",
  muted: "text-tone-muted bg-tone-muted/14",
}

/**
 * The Kvit soft pill for a tone, with a label the caller has already translated. Status colours
 * live only here. `StatusBadge` is this pill for a status of a domain.
 *
 * The dot is decoration: muted is a ring and every other tone a solid dot, so the shape differs
 * where the colour might not. Turn it off with `dot={false}` where the pill sits tight (chips).
 */
export function StatusPill({
  tone,
  children,
  dot = true,
  className,
}: {
  tone: StatusTone
  children: ReactNode
  dot?: boolean
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
      {dot ? (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            tone === "muted" ? "border-[1.5px] border-current" : "bg-current"
          )}
        />
      ) : null}
      {children}
    </span>
  )
}
