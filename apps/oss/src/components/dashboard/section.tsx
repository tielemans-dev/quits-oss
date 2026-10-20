import type { ComponentProps, ReactNode } from "react"

import { cn } from "../../lib/utils"

/**
 * A part of the Overblik: a 14/500 heading with an optional quiet action on the right, then its
 * rows between hairlines. No box, so the page reads as one sheet, as on Mercury's home.
 */
export function DashboardSection({
  title,
  action,
  className,
  children,
  ...props
}: Omit<ComponentProps<"section">, "title"> & { title: ReactNode; action?: ReactNode }) {
  return (
    <section className={cn("@container min-w-0", className)} {...props}>
      <header className="flex min-h-8 items-center justify-between gap-3 pb-1">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}

/**
 * A row of a section without its padding, for rows whose content grows in. Its hover reaches a
 * little past the text on both sides; the hairline above it stays in line with the heading.
 */
export const sectionRowFrame =
  "before:border-hairline relative -mx-3 rounded-md transition-colors duration-(--duration-fade) before:pointer-events-none before:absolute before:inset-x-3 before:top-0 before:border-t hover:bg-(--neutral-6) has-[a:focus-visible]:bg-(--neutral-6)"

/** One row of a section: a hairline above it, and room for a stretched link and its hover. */
export const sectionRowClass = `${sectionRowFrame} px-3 py-3`

/** What a section says when it has nothing to list: one quiet line on the hairline. */
export function SectionEmpty({ children }: { children: ReactNode }) {
  return <p className="border-hairline text-muted-foreground border-t py-3 text-sm">{children}</p>
}
