import type { ComponentProps, ElementType } from "react"

import { cn } from "../../lib/utils"

/**
 * The micro-label: Geist Mono, uppercase, +8% tracking, muted. It names a panel or a figure
 * (`UDESTÅENDE`); it is not for sentences. Render it as the element that fits, via `as`.
 */
export function MonoLabel({
  as: Tag = "span",
  className,
  ...props
}: Omit<ComponentProps<"span">, "ref"> & { as?: ElementType }) {
  return <Tag data-slot="mono-label" className={cn("mono-label", className)} {...props} />
}
