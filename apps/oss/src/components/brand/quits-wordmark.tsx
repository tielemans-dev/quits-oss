import type { ComponentProps } from "react"

import { cn } from "../../lib/utils"

/**
 * The wordmark: `quits` in Schibsted Grotesk with the double rule under it. The rules are the
 * brand colour and draw to the width of the word. Sized by `font-size`, so give it a `text-*`
 * class; it reads as text for screen readers.
 */
export function QuitsWordmark({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      {...props}
      className={cn(
        "relative inline-block pb-[0.3em] leading-none font-extrabold tracking-[-0.03em] text-foreground",
        "before:absolute before:right-0 before:bottom-[0.16em] before:left-0 before:h-[0.085em] before:rounded-full before:bg-brand before:content-['']",
        "after:absolute after:right-0 after:bottom-0 after:left-0 after:h-[0.085em] after:rounded-full after:bg-brand after:content-['']",
        className
      )}
    >
      quits
    </span>
  )
}
