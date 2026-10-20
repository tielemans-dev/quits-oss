import type { ReactNode } from "react"

import { cn } from "../../lib/utils"

/**
 * The top of a page: the title, a subtitle below it, and the page's actions on the right, centred
 * on the title. On a narrow screen the actions drop under the title.
 * The page container sets the width; this only lays out the header.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header
      data-slot="page-header"
      className={cn("mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3", className)}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-medium tracking-[-0.01em] text-balance">{title}</h1>
        {subtitle ? <p className="text-muted-foreground mt-1 text-sm">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}
