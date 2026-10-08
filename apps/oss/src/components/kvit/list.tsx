import type { CSSProperties, ComponentProps, ReactNode } from "react"
import { Plus } from "lucide-react"

import { cn } from "../../lib/utils"

/**
 * The list of a document page: a div-based ARIA table, so the rows can be a grid that turns into
 * a card on a narrow space and still read as a table with rows to a screen reader.
 *
 * The layout follows the width of the list, not of the window: the sidebar takes 16rem of a laptop
 * screen, so a viewport breakpoint would squeeze the grid. The table is a container and has three
 * tiers: below 56rem (`@4xl`) every row is a two-column card; from 56rem it is a grid on
 * `compactColumns`; from 64rem (`@5xl`) on `columns`, which has one column more (the issue date).
 * In the card tier the header is visually hidden but stays in the accessibility tree, and the
 * cells that do not fit are `hidden` in the header and in every row alike, so the column counts
 * match. Pages place the card cells with `@max-4xl:col-start-* @max-4xl:row-start-*`.
 */
export function ListTable({
  label,
  columns,
  compactColumns,
  className,
  style,
  children,
  ...props
}: ComponentProps<"div"> & {
  label: string
  /** Grid template from 64rem. */
  columns: string
  /** Grid template from 56rem to 64rem: `columns` without the issue date. */
  compactColumns: string
}) {
  return (
    <div
      role="table"
      aria-label={label}
      data-slot="list-table"
      style={{ "--list-cols": columns, "--list-cols-compact": compactColumns, ...style } as CSSProperties}
      className={cn(
        "border-hairline bg-panel @container overflow-hidden rounded-xl border shadow-[0_1px_2px_rgb(16_18_27/6%)] dark:shadow-none",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function ListHead({ children }: { children: ReactNode }) {
  return (
    <div role="rowgroup">
      <div
        role="row"
        className="border-hairline items-center gap-x-4 border-b px-4 py-2.5 @max-4xl:sr-only @4xl:grid @4xl:grid-cols-(--list-cols-compact) @5xl:grid-cols-(--list-cols)"
      >
        {children}
      </div>
    </div>
  )
}

export function ListHeadCell({
  align = "start",
  className,
  children,
}: {
  align?: "start" | "end"
  className?: string
  children?: ReactNode
}) {
  return (
    <div
      role="columnheader"
      className={cn(
        "mono-label text-[10.5px] tracking-[0.1em]",
        align === "end" && "text-right",
        className
      )}
    >
      {children}
    </div>
  )
}

export function ListBody({ children }: { children: ReactNode }) {
  return <div role="rowgroup">{children}</div>
}

/**
 * A row. Make exactly one cell hold the page's link and give that link `list-row-link`: it
 * stretches over the whole row, so the row is clickable and keyboard reachable as a link, and
 * anything with `relative z-10` (the row actions) stays clickable above it.
 */
export function ListRow({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="row"
      data-slot="list-row"
      className={cn(
        "group/row border-hairline relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-b px-4 py-3 transition-colors duration-150 last:border-b-0 @4xl:grid-cols-(--list-cols-compact) @4xl:py-2.5 @5xl:grid-cols-(--list-cols)",
        "hover:bg-foreground/[0.035] has-[a:focus-visible]:bg-foreground/[0.035] has-[a:focus-visible]:ring-ring has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-inset",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function ListCell({
  align = "start",
  className,
  children,
}: {
  align?: "start" | "end"
  className?: string
  children?: ReactNode
}) {
  return (
    <div
      role="cell"
      className={cn("min-w-0 text-sm", align === "end" && "text-right", className)}
    >
      {children}
    </div>
  )
}

/** Class for the link that stretches across its row; see `ListRow`. */
export const listRowLinkClass =
  "after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"

/**
 * Row actions: shown on hover and on keyboard focus where the device can hover, always where it
 * cannot (phones, tablets). Sits above the stretched row link.
 */
export const rowActionsClass =
  "relative z-10 flex justify-end [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:opacity-100 [@media(hover:hover)]:focus-within:opacity-100 transition-opacity duration-150"

/** Placeholder rows while the first load runs; the caller supplies the label read to screen readers. */
export function ListSkeleton({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" data-slot="list-skeleton">
      <span className="sr-only">{label}</span>
      <div
        aria-hidden="true"
        className="border-hairline bg-panel overflow-hidden rounded-xl border"
      >
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="border-hairline flex items-center gap-3 border-b px-4 py-3.5 last:border-b-0"
            style={{ opacity: 1 - index * 0.14 }}
          >
            <span className="bg-foreground/8 size-5 shrink-0 animate-pulse rounded-[6px]" />
            <span className="bg-foreground/8 h-3 w-1/3 animate-pulse rounded-full" />
            <span className="bg-foreground/8 ml-auto h-3 w-20 animate-pulse rounded-full" />
            <span className="bg-foreground/8 hidden h-5 w-16 animate-pulse rounded-full md:block" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * The first-run state of a list: a dashed "not yet" tile with a brand plus, and a ghost of the rows
 * that will appear. Not for a filtered list that matches nothing: that one needs a "clear filters"
 * action instead of "create".
 */
export function ListEmpty({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div
      data-slot="list-empty"
      className="border-hairline rounded-xl border border-dashed px-6 py-14 text-center"
    >
      <div
        aria-hidden="true"
        className="mx-auto mb-6 w-full max-w-sm space-y-2 [mask-image:linear-gradient(to_bottom,black,transparent)]"
      >
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="border-hairline bg-panel flex items-center gap-3 rounded-lg border px-3 py-2.5"
            style={{ opacity: 0.9 - index * 0.25 }}
          >
            <span className="bg-brand-soft size-5 shrink-0 rounded-[6px]" />
            <span className="bg-foreground/10 h-2.5 w-24 rounded-full" />
            <span className="bg-foreground/10 ml-auto h-2.5 w-14 rounded-full" />
          </div>
        ))}
      </div>
      <span className="bg-brand-soft text-brand-text mx-auto mb-3 grid size-9 place-items-center rounded-full">
        <Plus aria-hidden="true" className="size-4.5" />
      </span>
      <h2 className="text-base font-semibold tracking-[-0.01em]">{title}</h2>
      <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">{description}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  )
}
