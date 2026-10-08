import type { ComponentProps, ReactNode } from "react"

import { cn } from "../../lib/utils"
import { MonoLabel } from "./mono-label"

/**
 * A surface: 12px radius, a hairline, the panel colour. No shadow in the dark theme; the light
 * theme adds the faintest. With `label` it opens with a mono label header and an optional
 * `action` on the right (a link, a count).
 */
export function Panel({
  label,
  action,
  className,
  children,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  label?: ReactNode
  action?: ReactNode
}) {
  return (
    <section
      data-slot="panel"
      className={cn(
        "bg-panel text-card-foreground border-hairline rounded-xl border shadow-[0_1px_2px_rgb(16_18_27/6%)] dark:shadow-none",
        className
      )}
      {...props}
    >
      {label || action ? (
        <header className="flex min-h-11 items-center justify-between gap-3 px-4 pt-3.5 pb-1">
          {label ? <MonoLabel as="h2">{label}</MonoLabel> : <span />}
          {action}
        </header>
      ) : null}
      {children}
    </section>
  )
}
