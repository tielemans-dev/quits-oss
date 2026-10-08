import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import type { TranslationKey } from '../../../lib/i18n/messages'

/**
 * The command palette is a list of sections, each a list of items. A provider turns what the
 * person has typed into sections; the palette merges what every provider returns, in `order`,
 * and handles keyboard, focus and closing.
 *
 * To add behaviour, register a provider (see `registerPaletteProvider`). The slot a "draft an
 * invoice from a sentence" feature fills is exactly that: a provider whose `sections` parses the
 * query and returns one section with one item per draft it can build. Its `content` can render
 * the parsed chips instead of a plain label, and its `perform` creates the draft and navigates.
 */

/** What an item can do when chosen. */
export type PaletteActions = {
  /** Navigates to an app path and closes the palette. */
  navigate: (to: string) => void
  /** Closes the palette without navigating, for items that act in place. */
  close: () => void
}

/** What a provider may look at to decide what to offer. */
export type PaletteContext = {
  /** What the person typed, as typed. Empty when the palette has just opened. */
  query: string
  /** Whether the person may do the action, by the organization's role. */
  can: (action: PaletteCapability) => boolean
  /** Whether this deployment has billing, which decides whether Billing is offered. */
  billingEnabled: boolean
  /** Translates a catalogue key in the current language. */
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
}

/** The create actions the shell knows permissions for. */
export type PaletteCapability = 'invoice:create' | 'quote:create' | 'contact:create' | 'agreement:create'

export type PaletteItem = {
  /** Unique across all sections; also the DOM id of the option. */
  id: string
  /** The plain label. Used for matching, and shown unless `content` replaces it. */
  label: string
  /** Secondary text at the right, in the mono style. A path, a number, a shortcut. */
  hint?: string
  /** Extra words `matchItems` matches besides the label. Providers that filter themselves can ignore it. */
  keywords?: string[]
  icon?: LucideIcon
  /** Replaces the label with richer content, such as parsed chips. The label still names the option for assistive technology. */
  content?: ReactNode
  /** Run when the item is chosen. */
  perform: (actions: PaletteActions) => void
}

export type PaletteSection = {
  id: string
  /** The group heading. Omit it for a section that needs none. */
  heading?: string
  items: PaletteItem[]
}

export type PaletteProvider = {
  id: string
  /** Lower comes first. Built-ins use 100 (create) and 200 (navigate); free-text drafting should use less than 100. */
  order: number
  /**
   * Sections for the current query. May be async; a result for a query that has since changed is
   * dropped. Return an empty array to offer nothing.
   */
  sections: (context: PaletteContext) => PaletteSection[] | Promise<PaletteSection[]>
}
