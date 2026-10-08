import type { ReactNode } from "react"

import { cn } from "../../lib/utils"
import { MonoLabel } from "./mono-label"

/**
 * The top of a page: the title, an optional mono eyebrow above it, a subtitle below, and the
 * page's actions on the right. On a narrow screen the actions drop under the title.
 * The page container sets the width; this only lays out the header.
 */
export function PageHeader({
  title,
  eyebrow,
  subtitle,
  actions,
  className,
}: {
  title: ReactNode
  eyebrow?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header
      data-slot="page-header"
      className={cn("mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3", className)}
    >
      <div className="min-w-0">
        {eyebrow ? <MonoLabel as="p" className="mb-1.5">{eyebrow}</MonoLabel> : null}
        <h1 className="text-2xl font-bold tracking-[-0.02em]">{title}</h1>
        {subtitle ? <p className="text-muted-foreground mt-1 text-sm">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}
