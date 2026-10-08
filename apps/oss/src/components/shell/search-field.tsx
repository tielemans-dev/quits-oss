import { Search } from 'lucide-react'

import { useI18n } from '../../lib/i18n/react'
import { useSearchPlaceholderKey } from './palette'
import { cn } from '../../lib/utils'

/**
 * The top bar's entry to the command palette. It looks like a field but is a button: the palette
 * has the real input. Reads "Søg…" on a phone, where the keycap is hidden too.
 */
export function SearchField({ onOpen, className }: { onOpen: () => void; className?: string }) {
  const { t } = useI18n()
  const placeholderKey = useSearchPlaceholderKey()
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('shell.search.open')}
      aria-keyshortcuts="Control+K Meta+K /"
      className={cn(
        'group flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] border border-hairline bg-panel px-3 text-left text-sm text-muted-foreground outline-hidden',
        'transition-[border-color,box-shadow] duration-150 ease-out hover:border-brand/50 hover:shadow-[0_0_0_4px_var(--brand-soft)]',
        'focus-visible:border-brand/60 focus-visible:shadow-[0_0_0_4px_var(--brand-soft)]',
        className
      )}
    >
      <Search className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        <span className="sm:hidden">{t('shell.search.placeholderShort')}</span>
        <span className="max-sm:hidden">{t(placeholderKey)}</span>
      </span>
      <kbd
        aria-hidden="true"
        className="hidden shrink-0 rounded-[5px] border border-hairline px-1.5 py-px font-mono text-[11px] font-medium md:block"
      >
        ⌘K
      </kbd>
    </button>
  )
}
