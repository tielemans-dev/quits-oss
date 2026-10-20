/**
 * Matches a required field's label. The visible "*" is aria-hidden, so the accessible name is
 * unchanged, but Testing Library's label lookup reads the label's text content including it.
 */
export function requiredLabel(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\*$`)
}
