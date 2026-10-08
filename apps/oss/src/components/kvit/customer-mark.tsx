import type { CSSProperties } from "react"

import { cn } from "../../lib/utils"
import { deriveMarkColour, markInitials } from "./mark-colour"

const sizeClass = {
  sm: "size-5 rounded-[6px] text-[9.5px]",
  md: "size-7 rounded-lg text-[11px]",
} as const

/**
 * A rounded square with the initials of a customer, beside their name in a list. Decorative: the
 * name is always written next to it, so it is hidden from assistive technology.
 *
 * The colour is a mark colour derived from the name (see `mark-colour.ts`), not the customer's
 * brand colour. Pass `markColour` (any CSS colour) once contacts carry a real one; it replaces the
 * derived colour in both themes.
 */
export function CustomerMark({
  name,
  size = "sm",
  markColour,
  className,
}: {
  name: string
  size?: keyof typeof sizeClass
  markColour?: string
  className?: string
}) {
  const derived = markColour ? null : deriveMarkColour(name)
  const style = (
    derived
      ? { "--mark-h": derived.hue, "--mark-c": derived.chroma }
      : { backgroundColor: markColour }
  ) as CSSProperties

  return (
    <span
      aria-hidden="true"
      data-slot="customer-mark"
      style={style}
      className={cn(
        "inline-grid shrink-0 place-items-center font-extrabold leading-none text-white ring-1 ring-inset ring-black/5 dark:ring-white/10",
        // Light: L .5 holds white initials above 4.5:1. Dark: a deeper tile so it sits in the panel.
        derived &&
          "bg-[oklch(0.5_var(--mark-c)_var(--mark-h))] dark:bg-[oklch(0.44_var(--mark-c)_var(--mark-h))]",
        sizeClass[size],
        className
      )}
    >
      {markInitials(name)}
    </span>
  )
}
