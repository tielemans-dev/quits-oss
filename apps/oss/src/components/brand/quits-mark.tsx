import { useId, type ComponentProps } from "react"

import { cn } from "../../lib/utils"

/**
 * The Quits mark: a lowercase q cut out of an ink tile. The tile is `currentColor` and the q is
 * transparent, so the surface behind shows through and the mark reads in light and dark mode
 * without a second version. Keep it in step with `public/favicon.svg`.
 */
export function QuitsMark({ className, ...props }: ComponentProps<"svg">) {
  const maskId = `quits-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`

  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={cn("size-8 shrink-0", className)}
      {...props}
    >
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
        <rect width="32" height="32" fill="#fff" />
        <circle cx="15.8" cy="13.4" r="6.2" fill="none" stroke="#000" strokeWidth="3.4" />
        <path d="M22 9V24.8" stroke="#000" strokeWidth="3.4" strokeLinecap="round" />
      </mask>
      <rect width="32" height="32" rx="8" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  )
}
