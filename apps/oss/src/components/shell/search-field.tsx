import { Search } from 'lucide-react'
import type { Ref } from 'react'

import { useI18n } from '../../lib/i18n/react'
import { useSearchPlaceholderKey } from './palette'
import { cn } from '../../lib/utils'

/**
 * The top bar's entry to the command palette. It looks like a field but is a button: the palette
 * has the real input, and on a wide screen it grows out of this field (see `CommandPalette`'s
 * `anchor`). Reads "Søg…" on a phone, where the keycap is hidden too.
 */
export function SearchField({ onOpen, className, ref }: { onOpen: () => void; className?: string; ref?: Ref<HTMLButtonElement> }) {
  const { t } = useI18n()
  const placeholderKey = useSearchPlaceholderKey()
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-label={t('shell.search.open')}
      aria-keyshortcuts="Control+K Meta+K /"
      className={cn(
        'group flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm text-muted-foreground outline-hidden',
        'transition-colors duration-(--duration-fade) ease-enter hover:bg-(--neutral-6) hover:text-foreground',
        'focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
    >
      <Search className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        <span className="sm:hidden">{t('shell.search.placeholderShort')}</span>
        <span className="max-sm:hidden">{t(placeholderKey)}</span>
      </span>
      <kbd
        aria-hidden="true"
        className="hidden shrink-0 rounded-sm border border-hairline px-1.5 py-px font-mono text-2xs font-medium opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 md:block"
      >
        ⌘K
      </kbd>
    </button>
  )
}
