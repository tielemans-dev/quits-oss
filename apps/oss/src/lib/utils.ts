import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// `font-heading` and `tracking-heading` are theme tokens from styles.css, so a later `font-medium`
// or `tracking-tight` in a className replaces them like it would a built-in utility.
const twMerge = extendTailwindMerge({
  extend: { theme: { 'font-weight': ['heading'], tracking: ['heading'] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
