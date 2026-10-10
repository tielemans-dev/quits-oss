import type { ComponentProps } from "react"

import { cn } from "../../lib/utils"

/**
 * The quits mark: a `q` and the square full stop on a tile. The tile and the `q` follow `--brand`
 * and `--brand-foreground` (ink and paper in the light theme, swapped in the dark one); the stop
 * is always Settled green. The shapes sit on whole pixels at 32px so the mark holds as a favicon.
 * Keep it in step with `public/favicon.svg`.
 */
export function QuitsMark({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-8 shrink-0", className)} {...props}>
      <rect width="32" height="32" rx="7" style={{ fill: "var(--brand)" }} />
      <g style={{ fill: "var(--brand-foreground)" }}>
        <path
          fillRule="evenodd"
          d="M12 8H19V21H12C9.2385 21 7 18.7615 7 16V13C7 10.2385 9.2385 8 12 8ZM12.5 10H13.5C14.8807 10 16 11.1193 16 12.5V16.5C16 17.8807 14.8807 19 13.5 19H12.5C11.1193 19 10 17.8807 10 16.5V12.5C10 11.1193 11.1193 10 12.5 10Z"
        />
        <rect x="16" y="8" width="3" height="18" />
      </g>
      <rect x="21" y="17" width="4" height="4" style={{ fill: "var(--settled)" }} />
    </svg>
  )
}
