import type { ComponentProps, ReactNode } from "react"

import { cn } from "../../lib/utils"

/**
 * A surface: 12px radius, a hairline, the panel colour, no shadow. With `label` it opens with a
 * 14/500 heading in sentence case and an optional `action` on the right (a link, a count).
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
        "bg-panel text-card-foreground border-hairline rounded-xl border",
        className
      )}
      {...props}
    >
      {label || action ? (
        <header className="flex min-h-11 items-center justify-between gap-3 px-4 pt-3.5 pb-1">
          {label ? <h2 className="text-sm font-medium">{label}</h2> : <span />}
          {action}
        </header>
      ) : null}
      {children}
    </section>
  )
}
