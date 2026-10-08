import type { ComponentProps } from "react"

import { cn } from "../../lib/utils"

/**
 * The Quits mark: a q standing on a double rule, white on a Kvit-blå tile. The double rule is the
 * signature, the bookkeeping sign for "settled": two bars under a total. The bars sit on whole
 * pixels at 16px so the mark holds as a favicon. Keep it in step with `public/favicon.svg`.
 *
 * The tile follows `--brand`, so it is the brand colour in the app and ink on a public document
 * page (see styles.css).
 */
export function QuitsMark({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      fill="none"
      className={cn("size-8 shrink-0", className)}
      {...props}
    >
      <rect width="32" height="32" rx="8" style={{ fill: "var(--brand)" }} />
      <circle cx="14" cy="11.5" r="4.7" stroke="#fff" strokeWidth="3.2" />
      <path d="M19.7 7V18.3" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M7 23H25M7 27H25" stroke="#fff" strokeWidth="2" />
    </svg>
  )
}
