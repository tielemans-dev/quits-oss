import type { CSSProperties, ComponentProps, ReactNode } from "react"

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
 *
 * There is no box: the list sits on the page between hairlines. Rows bleed 12px past the text on
 * each side, so the text lines up with the page title and the hover fill has room.
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
        "@container -mx-3",
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
        className="border-hairline h-10 items-center gap-x-4 border-b px-3 @max-4xl:sr-only @4xl:grid @4xl:grid-cols-(--list-cols-compact) @5xl:grid-cols-(--list-cols)"
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
        "text-muted-foreground text-xs font-medium",
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
        "group/row border-hairline relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-b px-3 py-3 transition-colors duration-(--duration-fade) @4xl:min-h-13 @4xl:grid-cols-(--list-cols-compact) @4xl:py-2 @5xl:grid-cols-(--list-cols)",
        "hover:bg-(--neutral-6) has-[a:focus-visible]:bg-(--neutral-6) has-[a:focus-visible]:ring-ring has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-inset",
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
 * Row actions: in the wide table layout they show on hover and on keyboard focus where the device
 * can hover, and always where it cannot (phones, tablets). In the stacked layout there is no room
 * to hide them, so they always show and the row keeps one height. Sits above the stretched row link.
 */
export const rowActionsClass =
  "relative z-10 flex justify-end @4xl:[@media(hover:hover)]:opacity-0 @4xl:[@media(hover:hover)]:group-hover/row:opacity-100 @4xl:[@media(hover:hover)]:group-focus-within/row:opacity-100 @4xl:[@media(hover:hover)]:focus-within:opacity-100 transition-opacity duration-(--duration-fade)"

/** Placeholder rows while the first load runs; the caller supplies the label read to screen readers. */
export function ListSkeleton({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" data-slot="list-skeleton">
      <span className="sr-only">{label}</span>
      <div
        aria-hidden="true"
        className="border-hairline -mx-3 border-t"
      >
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="border-hairline flex h-13 items-center gap-3 border-b px-3">
            <span className="h-3 w-1/3 animate-pulse rounded-sm bg-(--neutral-6)" />
            <span className="ml-auto h-3 w-20 animate-pulse rounded-sm bg-(--neutral-6)" />
            <span className="hidden h-5 w-16 animate-pulse rounded-sm bg-(--neutral-6) md:block" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * The first-run state of a list: what will appear here and why it matters, and the action that
 * starts it. No illustration, no ghost rows. Not for a filtered list that matches nothing: that one
 * needs a "clear filters" action instead of "create".
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
    <div data-slot="list-empty" className="max-w-160 pt-16">
      <h2 className="text-xl font-medium tracking-[-0.01em]">{title}</h2>
      <p className="text-muted-foreground mt-2 text-sm">{description}</p>
      {action ? <div className="mt-6 flex">{action}</div> : null}
    </div>
  )
}
