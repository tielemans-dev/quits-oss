import type { CSSProperties, ReactNode } from "react"

import { cn } from "../../lib/utils"
import { Skeleton } from "./skeleton"

/**
 * A value and its skeleton in the same grid cell: the skeleton fades out where the value fills
 * in, so nothing moves. `index` staggers slots in reading order; without it the slot takes `--i`
 * from its surroundings. A slot that mounts filled plays
 * the fill once, which is how a page that replaces its loading skeleton fills in. The skeleton is
 * decoration and stays out of the accessibility tree.
 */
export function FillSlot({
  filled,
  index,
  width = "60%",
  className,
  as: Tag = "span",
  children,
}: {
  filled: boolean
  index?: number
  width?: string
  className?: string
  /** `div` for block content such as a group of fields. */
  as?: "span" | "div"
  children?: ReactNode
}) {
  return (
    <Tag className={cn("fill-slot", className)} data-filled={filled || undefined} style={index === undefined ? undefined : ({ "--i": index } as CSSProperties)}>
      <Skeleton aria-hidden="true" className="fill-slot-skeleton" style={{ width }} />
      <Tag className="fill-slot-value">{children}</Tag>
    </Tag>
  )
}
