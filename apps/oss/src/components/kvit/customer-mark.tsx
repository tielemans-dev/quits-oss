import { cn } from "../../lib/utils"
import { markInitials } from "./mark-colour"

const sizeClass = {
  sm: "size-5 text-2xs",
  md: "size-7 text-xs",
} as const

/**
 * A circle with the initials of a customer, beside their name in a list. Decorative: the name is
 * always written next to it, so it is hidden from assistive technology.
 *
 * It is neutral: a colour derived from the name would look like meaning it does not have. Pass
 * `markColour` (any CSS colour) once contacts carry a real brand colour; the initials turn white.
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
  return (
    <span
      aria-hidden="true"
      data-slot="customer-mark"
      style={markColour ? { backgroundColor: markColour } : undefined}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full font-medium leading-none",
        markColour ? "text-white" : "text-foreground bg-(--neutral-10)",
        sizeClass[size],
        className
      )}
    >
      {markInitials(name)}
    </span>
  )
}
